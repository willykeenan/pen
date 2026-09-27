// Synthetic macOS integration test for ke-pen-hold-helper. Test-only: never
// packaged. It drives the real helper binary with CGEvents posted at the HID
// level into a small sink panel in a screen corner and counts what reaches
// applications with a listen-only tap placed after the helper's session tap.
//
//   hold_it_mac <helper> <evidence.json>
//
// Exit status: 0 pass · 1 fail · 75 not idle or real input seen (retry later)
// · 77 no Accessibility for this process (the caller decides whether a skip
// is acceptable).
//
// The run takes a few seconds, refuses to start unless the machine has been
// idle for 10 s, aborts the moment real (non-synthetic) mouse input appears,
// and restores the cursor and the previously frontmost app afterwards.
#import <Cocoa/Cocoa.h>
#include <mach/mach_time.h>
#include <os/lock.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>

extern char **environ;
/* libSystem private; used only to check the helper disclaims responsibility. */
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid) __attribute__((weak_import));

#define HELPER_TAG ((int64_t)0x4B4550454E484C44LL) /* "KEPENHLD" (helper replays) */
#define TEST_TAG ((int64_t)0x4B45504E54455354LL)   /* "KEPNTEST" (this test's posts) */
#define THRESHOLD_MS 300
#define IDLE_REQUIRED_S 10.0

typedef NS_ENUM(NSInteger, Origin) { OriginOther = 0, OriginTest = 1, OriginHelper = 2 };

typedef struct {
  CGEventType type;
  Origin origin;
  uint64_t at_ns;
} Observed;

static os_unfair_lock g_lock = OS_UNFAIR_LOCK_INIT;
static Observed g_observed[512];
static int g_observed_count = 0;
static uint64_t g_holds[64];
static int g_hold_count = 0;
static BOOL g_helper_ready = NO;
static BOOL g_helper_active = NO;
static BOOL g_helper_needs_permission = NO;
static int g_tap_restored = 0;
static volatile BOOL g_real_input = NO;
static int g_sink_down = 0;
static int g_sink_up = 0;
static volatile BOOL g_menu_open = NO;
static volatile int g_menu_closes = 0;

static pid_t g_helper_pid = 0;
static int g_helper_stdin = -1;
static CGEventSourceRef g_source = NULL;
static CGPoint g_target;           /* sink centre, global display coordinates */
static NSPoint g_menu_location;    /* Cocoa screen coordinates */
static NSMenu *g_menu = nil;
static NSPanel *g_panel = nil;
static NSMutableDictionary *g_evidence = nil;
static CGPoint g_cursor_before;
static NSRunningApplication *g_front_before = nil;

static NSNumber *B(BOOL value) { return value ? @YES : @NO; }
static uint64_t now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }
static void sleep_ms(int ms) { usleep((useconds_t)ms * 1000); }

static Origin origin_of(CGEventRef event) {
  int64_t tag = CGEventGetIntegerValueField(event, kCGEventSourceUserData);
  if (tag == HELPER_TAG) return OriginHelper;
  if (tag == TEST_TAG) return OriginTest;
  return OriginOther;
}

// ---- What applications receive (after every session tap) -----------------

static CGEventRef observe(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  (void)proxy;
  (void)info;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) return event;
  if (CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber) != 2) return event;
  os_unfair_lock_lock(&g_lock);
  if (g_observed_count < 512) {
    g_observed[g_observed_count++] = (Observed){type, origin_of(event), now_ns()};
  }
  os_unfair_lock_unlock(&g_lock);
  return event;
}

// ---- Real input guard (before the helper) ---------------------------------

static CGEventRef guard(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  (void)proxy;
  (void)info;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) return event;
  if (origin_of(event) == OriginOther) g_real_input = YES;
  return event;
}

static BOOL add_tap(CGEventTapLocation location, CGEventMask mask, CGEventTapCallBack callback) {
  CFMachPortRef tap = CGEventTapCreate(location, kCGTailAppendEventTap, kCGEventTapOptionListenOnly,
                                       mask, callback, NULL);
  if (tap == NULL) return NO;
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);
  return YES;
}

// ---- Sink panel -----------------------------------------------------------

@interface SinkView : NSView
@end
@implementation SinkView
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (void)otherMouseDown:(NSEvent *)event {
  if (event.buttonNumber == 2) { os_unfair_lock_lock(&g_lock); g_sink_down++; os_unfair_lock_unlock(&g_lock); }
}
- (void)otherMouseUp:(NSEvent *)event {
  if (event.buttonNumber == 2) { os_unfair_lock_lock(&g_lock); g_sink_up++; os_unfair_lock_unlock(&g_lock); }
}
- (void)drawRect:(NSRect)rect {
  [[NSColor colorWithCalibratedRed:1.0 green:0.23 blue:0.16 alpha:0.9] setFill];
  NSRectFill(rect);
}
@end

@interface MenuWatcher : NSObject <NSMenuDelegate>
@end
@implementation MenuWatcher
- (void)menuWillOpen:(NSMenu *)menu { (void)menu; g_menu_open = YES; }
- (void)menuDidClose:(NSMenu *)menu { (void)menu; g_menu_open = NO; g_menu_closes++; }
@end
static MenuWatcher *g_menu_watcher = nil;

// ---- Helper process -------------------------------------------------------

static void send_command(const char *line) {
  if (g_helper_stdin < 0) return;
  size_t length = strlen(line);
  ssize_t written = write(g_helper_stdin, line, length);
  (void)written;
}

static void handle_helper_line(NSString *line) {
  NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *message = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![message isKindOfClass:[NSDictionary class]]) return;
  NSString *type = message[@"type"];
  os_unfair_lock_lock(&g_lock);
  if ([type isEqualToString:@"ready"]) g_helper_ready = YES;
  if ([type isEqualToString:@"active"]) g_helper_active = YES;
  if ([type isEqualToString:@"needs-permission"]) g_helper_needs_permission = YES;
  if ([type isEqualToString:@"hold"] && g_hold_count < 64) g_holds[g_hold_count++] = now_ns();
  if ([type isEqualToString:@"tap-restored"]) g_tap_restored++;
  os_unfair_lock_unlock(&g_lock);
}

static BOOL start_helper(NSString *helper) {
  int in_pipe[2], out_pipe[2];
  if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) return NO;
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, in_pipe[0], STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&actions, out_pipe[1], STDOUT_FILENO);
  posix_spawn_file_actions_addclose(&actions, in_pipe[1]);
  posix_spawn_file_actions_addclose(&actions, out_pipe[0]);
  const char *path = helper.fileSystemRepresentation;
  char *const argv[] = {(char *)path, NULL};
  int result = posix_spawn(&g_helper_pid, path, &actions, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&actions);
  close(in_pipe[0]);
  close(out_pipe[1]);
  if (result != 0) return NO;
  g_helper_stdin = in_pipe[1];
  os_unfair_lock_lock(&g_lock);
  g_helper_ready = NO;
  g_helper_active = NO;
  g_helper_needs_permission = NO;
  os_unfair_lock_unlock(&g_lock);

  int reader = out_pipe[0];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
    NSMutableData *pending = [NSMutableData data];
    char buffer[512];
    for (;;) {
      ssize_t count = read(reader, buffer, sizeof(buffer));
      if (count <= 0) break;
      [pending appendBytes:buffer length:(NSUInteger)count];
      for (;;) {
        const char *bytes = pending.bytes;
        const char *newline = memchr(bytes, '\n', pending.length);
        if (newline == NULL) break;
        NSUInteger length = (NSUInteger)(newline - bytes);
        NSString *line = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
        [pending replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0];
        if (line) handle_helper_line(line);
      }
    }
    close(reader);
  });
  return YES;
}

static BOOL wait_until(BOOL (^condition)(void), int timeout_ms) {
  uint64_t deadline = now_ns() + (uint64_t)timeout_ms * 1000000ull;
  while (now_ns() < deadline) {
    if (condition()) return YES;
    sleep_ms(10);
  }
  return condition();
}

static int wait_helper_exit(int timeout_ms, int *status_out) {
  uint64_t deadline = now_ns() + (uint64_t)timeout_ms * 1000000ull;
  int status = 0;
  while (now_ns() < deadline) {
    pid_t done = waitpid(g_helper_pid, &status, WNOHANG);
    if (done == g_helper_pid) {
      if (status_out) *status_out = status;
      g_helper_pid = 0;
      return 1;
    }
    sleep_ms(10);
  }
  return 0;
}

static void stop_helper(void) {
  if (g_helper_stdin >= 0) {
    close(g_helper_stdin);
    g_helper_stdin = -1;
  }
  if (g_helper_pid > 0) {
    if (!wait_helper_exit(1000, NULL)) {
      kill(g_helper_pid, SIGKILL);
      waitpid(g_helper_pid, NULL, 0);
    }
    g_helper_pid = 0;
  }
}

static BOOL configure_helper(BOOL arm) {
  char line[96];
  snprintf(line, sizeof(line), "{\"cmd\":\"config\",\"thresholdMs\":%d}\n", THRESHOLD_MS);
  send_command(line);
  send_command(arm ? "{\"cmd\":\"arm\"}\n" : "{\"cmd\":\"disarm\"}\n");
  sleep_ms(60);
  return YES;
}

// ---- Posting ------------------------------------------------------------------

static void post(CGEventType type, CGFloat dx, CGFloat dy) {
  CGPoint point = CGPointMake(g_target.x + dx, g_target.y + dy);
  CGEventRef event = CGEventCreateMouseEvent(g_source, type, point, kCGMouseButtonCenter);
  CGEventSetIntegerValueField(event, kCGMouseEventButtonNumber, 2);
  if (type != kCGEventOtherMouseDragged) CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

static void reset_counts(void) {
  os_unfair_lock_lock(&g_lock);
  g_observed_count = 0;
  g_hold_count = 0;
  g_sink_down = 0;
  g_sink_up = 0;
  g_tap_restored = 0;
  os_unfair_lock_unlock(&g_lock);
}

typedef struct {
  int downs, ups, drags;
  int helper_downs, helper_ups, test_downs, test_ups;
  uint64_t first_down_ns;
  CGEventType first_type;
  Origin first_origin;
  int holds;
  uint64_t first_hold_ns;
  int total;
} Snapshot;

static Snapshot snapshot(void) {
  Snapshot s = {0};
  os_unfair_lock_lock(&g_lock);
  s.total = g_observed_count;
  for (int i = 0; i < g_observed_count; i++) {
    Observed o = g_observed[i];
    if (i == 0) { s.first_type = o.type; s.first_origin = o.origin; }
    if (o.type == kCGEventOtherMouseDown) {
      if (s.downs == 0) s.first_down_ns = o.at_ns;
      s.downs++;
      if (o.origin == OriginHelper) s.helper_downs++;
      if (o.origin == OriginTest) s.test_downs++;
    } else if (o.type == kCGEventOtherMouseUp) {
      s.ups++;
      if (o.origin == OriginHelper) s.helper_ups++;
      if (o.origin == OriginTest) s.test_ups++;
    } else if (o.type == kCGEventOtherMouseDragged) {
      s.drags++;
    }
  }
  s.holds = g_hold_count;
  s.first_hold_ns = g_hold_count > 0 ? g_holds[0] : 0;
  os_unfair_lock_unlock(&g_lock);
  return s;
}

static NSMutableArray *g_results = nil;
static BOOL g_all_passed = YES;

static void record(NSString *name, BOOL passed, NSDictionary *facts) {
  NSMutableDictionary *entry = [NSMutableDictionary dictionaryWithDictionary:facts];
  entry[@"scenario"] = name;
  entry[@"passed"] = B(passed);
  [g_results addObject:entry];
  if (!passed) g_all_passed = NO;
  fprintf(stdout, "%s %s\n", passed ? "ok  " : "FAIL", name.UTF8String);
  fflush(stdout);
}

static double ms_between(uint64_t from, uint64_t to) {
  return to >= from ? (double)(to - from) / 1e6 : -(double)(from - to) / 1e6;
}

static void check_real_input(void) {
  if (g_real_input) {
    fprintf(stderr, "Real mouse input appeared; aborting so nothing interferes. Retry when idle.\n");
    stop_helper();
    CGWarpMouseCursorPosition(g_cursor_before);
    exit(75);
  }
}

// ---- Scenarios ----------------------------------------------------------------

static void scenario_short_click(void) {
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(80);
  uint64_t released = now_ns();
  post(kCGEventOtherMouseUp, 0, 0);
  sleep_ms(400);
  Snapshot s = snapshot();
  BOOL passed = s.downs == 1 && s.ups == 1 && s.helper_downs == 1 && s.helper_ups == 1 &&
                s.holds == 0 && s.first_down_ns >= released && s.drags == 0;
  record(@"short-click-replayed-after-release", passed, @{
    @"deliveredDowns" : @(s.downs), @"deliveredUps" : @(s.ups),
    @"replayedByHelper" : B(s.helper_downs == 1 && s.helper_ups == 1),
    @"deliveredAfterRelease" : B(s.first_down_ns >= released),
    @"downDeliveredMsAfterRelease" : @(s.downs ? ms_between(released, s.first_down_ns) : -1),
    @"holds" : @(s.holds)
  });
}

static void scenario_long_hold(void) {
  reset_counts();
  uint64_t pressed = now_ns();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(800);
  post(kCGEventOtherMouseUp, 0, 0);
  sleep_ms(300);
  Snapshot s = snapshot();
  double hold_ms = s.holds ? ms_between(pressed, s.first_hold_ns) : -1;
  BOOL passed = s.holds == 1 && hold_ms >= THRESHOLD_MS && hold_ms <= THRESHOLD_MS + 150 &&
                s.total == 0;
  record(@"long-hold-fires-and-swallows", passed, @{
    @"holds" : @(s.holds), @"holdMsAfterPress" : @(hold_ms), @"thresholdMs" : @(THRESHOLD_MS),
    @"middleEventsDeliveredToApps" : @(s.total)
  });
}

static void scenario_drag(void) {
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(40);
  for (int step = 1; step <= 6; step++) {
    post(kCGEventOtherMouseDragged, step * 5, 0);
    sleep_ms(15);
  }
  post(kCGEventOtherMouseUp, 30, 0);
  sleep_ms(THRESHOLD_MS + 150);
  Snapshot s = snapshot();
  BOOL passed = s.holds == 0 && s.downs == 1 && s.helper_downs == 1 && s.ups == 1 &&
                s.test_ups == 1 && s.drags >= 1 && s.first_type == kCGEventOtherMouseDown;
  record(@"drag-past-slop-passes-through", passed, @{
    @"holds" : @(s.holds), @"deliveredDowns" : @(s.downs), @"downReplayedFirst" :
    B(s.first_type == kCGEventOtherMouseDown && s.first_origin == OriginHelper),
    @"deliveredDrags" : @(s.drags), @"deliveredUps" : @(s.ups)
  });
}

static void scenario_disarm_mid_press(void) {
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(100);
  send_command("{\"cmd\":\"disarm\"}\n");
  sleep_ms(THRESHOLD_MS + 200);
  post(kCGEventOtherMouseUp, 0, 0);
  sleep_ms(300);
  Snapshot s = snapshot();
  send_command("{\"cmd\":\"arm\"}\n");
  sleep_ms(60);
  BOOL passed = s.holds == 0 && s.helper_downs == 1 && s.helper_ups == 1 && s.downs == 1 && s.ups == 1;
  record(@"disarm-mid-press-replays-click", passed, @{
    @"holds" : @(s.holds), @"deliveredDowns" : @(s.downs), @"deliveredUps" : @(s.ups)
  });
}

// Run-loop blocks rather than the main dispatch queue: popping a menu up
// blocks inside its block while the menu tracks, and the serial main queue
// would hold every later block (including cancelTracking) until it closed.
static void on_main(void (^block)(void)) {
  CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, block);
  CFRunLoopWakeUp(CFRunLoopGetMain());
}

static void open_menu(void) {
  on_main(^{
    [g_menu popUpMenuPositioningItem:nil atLocation:g_menu_location inView:nil];
  });
}

static void close_menu(void) {
  on_main(^{
    [g_menu cancelTrackingWithoutAnimation];
  });
}

static void scenario_menu_stays_open(void) {
  // Control: with the helper disarmed, a middle click outside an open menu
  // reaches the system like any click would.
  send_command("{\"cmd\":\"disarm\"}\n");
  sleep_ms(60);
  int closes_before = g_menu_closes;
  open_menu();
  BOOL opened = wait_until(^BOOL { return g_menu_open; }, 1500);
  sleep_ms(150);
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(60);
  post(kCGEventOtherMouseUp, 0, 0);
  BOOL control_closed = wait_until(^BOOL { return !g_menu_open; }, 700);
  Snapshot control = snapshot();
  if (g_menu_open) {
    close_menu();
    wait_until(^BOOL { return !g_menu_open; }, 1000);
  }
  (void)closes_before;

  // Armed: a long hold never reaches the menu, which stays open throughout.
  send_command("{\"cmd\":\"arm\"}\n");
  sleep_ms(60);
  open_menu();
  BOOL reopened = wait_until(^BOOL { return g_menu_open; }, 1500);
  sleep_ms(150);
  reset_counts();
  int closes_at_press = g_menu_closes;
  post(kCGEventOtherMouseDown, 0, 0);
  BOOL fired = wait_until(^BOOL { return snapshot().holds > 0; }, THRESHOLD_MS + 400);
  BOOL open_at_fire = g_menu_open && g_menu_closes == closes_at_press;
  post(kCGEventOtherMouseUp, 0, 0);
  sleep_ms(250);
  BOOL open_after_release = g_menu_open && g_menu_closes == closes_at_press;
  Snapshot armed = snapshot();
  close_menu();
  BOOL closed_by_cancel = wait_until(^BOOL { return !g_menu_open; }, 1500);

  BOOL passed = opened && reopened && fired && open_at_fire && open_after_release &&
                armed.total == 0 && closed_by_cancel;
  record(@"menu-stays-open-through-hold", passed, @{
    @"menuOpened" : @(reopened), @"holdFired" : @(fired), @"menuOpenWhenHoldFired" : @(open_at_fire),
    @"menuOpenAfterRelease" : @(open_after_release), @"middleEventsDeliveredWhileArmed" : @(armed.total),
    @"closedByCancelTracking" : @(closed_by_cancel),
    @"controlDisarmedClickDelivered" : B(control.downs == 1 && control.ups == 1),
    @"controlDisarmedClickClosedMenu" : @(control_closed)
  });
}

static void scenario_eof_while_pending(NSString *helper) {
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(100);
  close(g_helper_stdin);
  g_helper_stdin = -1;
  int status = 0;
  BOOL exited = wait_helper_exit(1500, &status);
  sleep_ms(150);
  Snapshot replayed = snapshot();
  post(kCGEventOtherMouseUp, 0, 0); // the person's real release, now an orphan
  sleep_ms(150);
  BOOL passed = exited && WIFEXITED(status) && WEXITSTATUS(status) == 0 &&
                replayed.helper_downs == 1 && replayed.helper_ups == 1 && replayed.holds == 0;
  record(@"stdin-eof-while-pending-gives-click-back", passed, @{
    @"helperExited" : B(exited), @"exitStatus" : @(WIFEXITED(status) ? WEXITSTATUS(status) : -1),
    @"replayedDowns" : @(replayed.helper_downs), @"replayedUps" : @(replayed.helper_ups)
  });

  // A crash while pending loses that one click by design, but nothing after it.
  if (!start_helper(helper) ||
      !wait_until(^BOOL { return g_helper_active || g_helper_needs_permission; }, 3000) ||
      !g_helper_active) {
    record(@"sigkill-while-pending-leaves-nothing-swallowed", NO, @{@"helperRestarted" : @NO});
    return;
  }
  configure_helper(YES);
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(100);
  kill(g_helper_pid, SIGKILL);
  BOOL killed = wait_helper_exit(1500, NULL);
  close(g_helper_stdin);
  g_helper_stdin = -1;
  sleep_ms(150);
  post(kCGEventOtherMouseUp, 0, 0);
  sleep_ms(60);
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(60);
  post(kCGEventOtherMouseUp, 0, 0);
  sleep_ms(200);
  Snapshot after = snapshot();
  // Expected: orphan up, then a normal click, all straight from this test.
  BOOL after_passed = killed && after.test_downs == 1 && after.test_ups == 2 &&
                      after.helper_downs == 0 && after.holds == 0;
  record(@"sigkill-while-pending-leaves-nothing-swallowed", after_passed, @{
    @"helperKilled" : @(killed), @"clicksDeliveredAfterKill" : @(after.test_downs),
    @"upsDeliveredAfterKill" : @(after.test_ups)
  });
}

// macOS disables a tap whose callback stops answering and passes events on
// without it. A helper frozen mid-press must, once it runs again, keep a press
// that is still held (and still swallow its up), and give back a press whose
// release went by while it was frozen instead of reporting a hold.
static void scenario_tap_timeout_keeps_held_press(void) {
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(100);
  kill(g_helper_pid, SIGSTOP);
  post(kCGEventOtherMouseDragged, 1, 0); /* within the slop; makes the tap time out */
  sleep_ms(2200);
  kill(g_helper_pid, SIGCONT);
  sleep_ms(600);
  post(kCGEventOtherMouseUp, 1, 0);
  sleep_ms(300);
  Snapshot s = snapshot();
  int restored;
  os_unfair_lock_lock(&g_lock);
  restored = g_tap_restored;
  os_unfair_lock_unlock(&g_lock);
  BOOL passed = restored >= 1 && s.holds == 1 && s.downs == 0 && s.ups == 0;
  record(@"tap-timeout-keeps-held-press", passed, @{
    @"tapRestored" : @(restored), @"holds" : @(s.holds), @"deliveredDowns" : @(s.downs),
    @"deliveredUps" : @(s.ups)
  });
}

static void scenario_tap_timeout_after_release_gives_click_back(void) {
  reset_counts();
  post(kCGEventOtherMouseDown, 0, 0);
  sleep_ms(100);
  kill(g_helper_pid, SIGSTOP);
  post(kCGEventOtherMouseUp, 0, 0); /* goes by while the helper is frozen */
  sleep_ms(2200);
  kill(g_helper_pid, SIGCONT);
  sleep_ms(700);
  Snapshot s = snapshot();
  BOOL passed = s.holds == 0 && s.helper_downs == 1 && s.helper_ups == 1;
  record(@"tap-timeout-after-release-gives-click-back", passed, @{
    @"holds" : @(s.holds), @"replayedDowns" : @(s.helper_downs), @"replayedUps" : @(s.helper_ups),
    @"unwatchedUpsDelivered" : @(s.test_ups)
  });
}

// The shipped helper holds its own Accessibility approval: it re-executes
// itself as its own responsible process, so macOS never checks (or lends it)
// the approval of whoever started it.
static void scenario_disclaimed_helper(NSString *helper) {
  int in_pipe[2], out_pipe[2];
  pid_t pid = 0;
  if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) {
    record(@"helper-is-its-own-responsible-process", NO, @{@"started" : @NO});
    return;
  }
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, in_pipe[0], STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&actions, out_pipe[1], STDOUT_FILENO);
  posix_spawn_file_actions_addclose(&actions, in_pipe[1]);
  posix_spawn_file_actions_addclose(&actions, out_pipe[0]);
  const char *path = helper.fileSystemRepresentation;
  char *const argv[] = {(char *)path, NULL};
  unsetenv("KE_PEN_HOLD_INHERIT_RESPONSIBILITY");
  int result = posix_spawn(&pid, path, &actions, NULL, argv, environ);
  setenv("KE_PEN_HOLD_INHERIT_RESPONSIBILITY", "1", 1);
  posix_spawn_file_actions_destroy(&actions);
  close(in_pipe[0]);
  close(out_pipe[1]);
  NSMutableString *output = [NSMutableString string];
  uint64_t deadline = now_ns() + 3000ull * 1000000ull;
  while (result == 0 && now_ns() < deadline &&
         !([output containsString:@"\"needs-permission\""] || [output containsString:@"\"active\""])) {
    struct pollfd descriptor = {out_pipe[0], POLLIN, 0};
    if (poll(&descriptor, 1, 100) > 0) {
      char buffer[512];
      ssize_t count = read(out_pipe[0], buffer, sizeof(buffer));
      if (count <= 0) break;
      [output appendString:[[NSString alloc] initWithBytes:buffer length:(NSUInteger)count
                                                  encoding:NSUTF8StringEncoding] ?: @""];
    }
  }
  pid_t responsible = (result == 0 && responsibility_get_pid_responsible_for_pid != NULL)
                          ? responsibility_get_pid_responsible_for_pid(pid)
                          : -1;
  BOOL reported = [output containsString:@"\"needs-permission\""] || [output containsString:@"\"active\""];
  ssize_t written = write(in_pipe[1], "{\"cmd\":\"quit\"}\n", 15);
  (void)written;
  close(in_pipe[1]);
  int status = 0;
  if (result == 0) waitpid(pid, &status, 0);
  close(out_pipe[0]);
  BOOL passed = result == 0 && reported && responsible == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0;
  record(@"helper-is-its-own-responsible-process", passed, @{
    @"responsibleIsSelf" : B(responsible == pid),
    @"reportedPermissionState" : [output containsString:@"\"active\""] ? @"active" : reported ? @"needs-permission" : @"none",
    @"exitedCleanly" : B(WIFEXITED(status) && WEXITSTATUS(status) == 0)
  });
}

// ---- Main -------------------------------------------------------------------

static void finish(NSString *evidence_path, int status, NSString *note) {
  stop_helper();
  CGWarpMouseCursorPosition(g_cursor_before);
  CGAssociateMouseAndMouseCursorPosition(true);
  // Only undo a focus change this test caused; if the person switched apps on
  // their own, that choice stands.
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (g_front_before && [front isEqual:NSRunningApplication.currentApplication]) {
    [g_front_before activateWithOptions:0];
  }
  g_evidence[@"frontmostRestored"] = B(g_front_before == nil ||
                                       ![NSWorkspace.sharedWorkspace.frontmostApplication
                                           isEqual:NSRunningApplication.currentApplication]);
  g_evidence[@"scenarios"] = g_results;
  g_evidence[@"passed"] = B(status == 0);
  if (note) g_evidence[@"note"] = note;
  NSData *json = [NSJSONSerialization dataWithJSONObject:g_evidence
                                                 options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                   error:nil];
  [json writeToFile:evidence_path atomically:YES];
  chmod(evidence_path.fileSystemRepresentation, 0600);
  fprintf(stdout, "%s\n", status == 0 ? "PEN_MIDDLE_HOLD_MAC_IT_OK" : "PEN_MIDDLE_HOLD_MAC_IT_FAILED");
  fflush(stdout);
  exit(status);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "usage: hold_it_mac <helper> <evidence.json>\n");
      return 64;
    }
    NSString *helper = [NSString stringWithUTF8String:argv[1]];
    /* Scenarios drive the helper under this process's own Accessibility
     * approval; scenario_disclaimed_helper checks the shipped default. */
    setenv("KE_PEN_HOLD_INHERIT_RESPONSIBILITY", "1", 1);
    NSString *evidence_path = [NSString stringWithUTF8String:argv[2]];
    g_results = [NSMutableArray array];
    g_evidence = [NSMutableDictionary dictionaryWithDictionary:@{
      @"contract" : @"ke.pen.middle-hold.mac-integration.v1",
      @"thresholdMs" : @(THRESHOLD_MS),
      @"postedAt" : @"kCGHIDEventTap",
      @"observedAt" : @"kCGAnnotatedSessionEventTap",
      @"positionsRecorded" : @NO
    }];

    double idle = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState,
                                                         kCGAnyInputEventType);
    if (idle < IDLE_REQUIRED_S) {
      fprintf(stderr, "Input was used %.1f s ago; waiting for %.0f s of idle time.\n", idle, IDLE_REQUIRED_S);
      return 75;
    }
    if (!AXIsProcessTrusted()) {
      fprintf(stderr, "This process has no Accessibility access; the event taps cannot run here.\n");
      return 77;
    }

    CGEventRef probe = CGEventCreate(NULL);
    g_cursor_before = CGEventGetLocation(probe);
    CFRelease(probe);
    g_front_before = NSWorkspace.sharedWorkspace.frontmostApplication;

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSScreen *primary = NSScreen.screens.firstObject;
    NSRect frame = primary.frame;
    NSRect sinkFrame = NSMakeRect(NSMinX(frame) + 24, NSMinY(frame) + 96, 160, 120);
    g_panel = [[NSPanel alloc] initWithContentRect:sinkFrame
                                         styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                           backing:NSBackingStoreBuffered
                                             defer:NO];
    g_panel.level = NSScreenSaverWindowLevel;
    g_panel.hidesOnDeactivate = NO;
    g_panel.contentView = [[SinkView alloc] initWithFrame:NSMakeRect(0, 0, 160, 120)];
    [g_panel orderFrontRegardless];
    // CoreGraphics global coordinates have their origin at the primary
    // display's top-left corner; Cocoa's is at its bottom-left.
    g_target = CGPointMake(NSMidX(sinkFrame), NSHeight(frame) - NSMidY(sinkFrame));
    g_menu_location = NSMakePoint(NSMaxX(sinkFrame) + 60, NSMaxY(sinkFrame) + 200);

    g_menu = [[NSMenu alloc] initWithTitle:@"KE Pen hold test"];
    [g_menu addItemWithTitle:@"Menu that must stay open" action:NULL keyEquivalent:@""];
    [g_menu addItemWithTitle:@"Second item" action:NULL keyEquivalent:@""];
    g_menu_watcher = [MenuWatcher new];
    g_menu.delegate = g_menu_watcher;

    g_source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    CGEventSourceSetUserData(g_source, TEST_TAG); /* the tag rides on the source */
    CGEventMask middle = CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) |
                         CGEventMaskBit(kCGEventOtherMouseDragged);
    CGEventMask pointer = CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDown) |
                          CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventScrollWheel) |
                          CGEventMaskBit(kCGEventLeftMouseDragged) | middle;
    if (!add_tap(kCGAnnotatedSessionEventTap, middle, observe) || !add_tap(kCGHIDEventTap, pointer, guard)) {
      fprintf(stderr, "Could not install the listen-only observer taps.\n");
      return 77;
    }

    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      sleep_ms(300);
      if (!start_helper(helper)) finish(evidence_path, 1, @"The helper could not be started.");
      BOOL ready = wait_until(^BOOL { return g_helper_active || g_helper_needs_permission; }, 3000);
      if (!ready || g_helper_needs_permission) {
        stop_helper();
        g_evidence[@"helperNeedsPermission"] = @(g_helper_needs_permission);
        finish(evidence_path, g_helper_needs_permission ? 77 : 1,
               g_helper_needs_permission ? @"The helper reported needs-permission."
                                         : @"The helper never became active.");
      }
      configure_helper(YES);
      uint64_t started = now_ns();

      scenario_short_click();
      check_real_input();
      scenario_long_hold();
      check_real_input();
      scenario_drag();
      check_real_input();
      scenario_disarm_mid_press();
      check_real_input();
      scenario_menu_stays_open();
      check_real_input();
      scenario_tap_timeout_keeps_held_press();
      check_real_input();
      scenario_tap_timeout_after_release_gives_click_back();
      check_real_input();
      scenario_disclaimed_helper(helper);
      check_real_input();
      scenario_eof_while_pending(helper);
      check_real_input();

      g_evidence[@"durationMs"] = @(ms_between(started, now_ns()));
      finish(evidence_path, g_all_passed ? 0 : 1, nil);
    });
    [NSApp run];
  }
  return 0;
}
