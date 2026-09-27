/*
 * ke-pen-hold-helper for macOS.
 *
 * An active session event tap that only ever looks at the middle mouse button
 * (button number 2). While KE Pen has armed it, a middle-button down is held
 * back so an open menu in another app never sees it. Released quickly, the
 * same click is re-posted at its original location. Held past the threshold,
 * the helper tells KE Pen to freeze the screen and open its selector, and the
 * matching up is swallowed.
 *
 * The helper talks to KE Pen over stdio (see protocol.h). It starts disarmed,
 * exits when stdin closes or its parent exits, and gives back any click it is
 * still holding when it stops. It never logs or reports a position.
 *
 * The Accessibility approval an active tap needs belongs to this helper, not
 * to KE Pen: at start the helper re-executes itself with macOS's "disclaim
 * responsibility" spawn attribute, so macOS checks and lists the helper's own
 * code. KE Pen (an Electron app) never asks for Accessibility, and nothing
 * that can run code as KE Pen can borrow an approval it does not have.
 */
#include <ApplicationServices/ApplicationServices.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "hold_core.h"
#include "protocol.h"

/* scripts/build-native.mjs generates ke_pen_version.h from package.json. A
 * header, not a -D string, so no shell or compiler driver can mangle quotes. */
#ifdef KE_PEN_HAVE_VERSION_H
#include "ke_pen_version.h"
#endif
#ifndef KE_PEN_VERSION
#define KE_PEN_VERSION "0.0.0-dev"
#endif

/* "KEPENHLD" in kCGEventSourceUserData marks the events this helper posts, so
 * the tap lets its own replays through and they can never loop. The value is
 * carried by the replay event source: setting the field on a copied event does
 * not survive posting, re-sourcing the copy does. */
#define KE_PEN_REPLAY_TAG ((int64_t)0x4B4550454E484C44LL)
#define MIDDLE_BUTTON 2
#define SLOP_POINTS 6.0
#define PERMISSION_POLL_SECONDS 2.0
/* How often a running tap is checked: macOS disables a tap whose callback was
 * too slow but only says so with the next event, which by then has gone
 * straight to the app. The check re-enables it within a second instead. */
#define WATCHDOG_SECONDS 1.0
/* Every third watchdog tick also re-checks the Accessibility approval. */
#define TRUST_CHECK_EVERY_TICKS 3
#define DISTANT_FUTURE_SECONDS 1.0e10
/* Set on the re-executed helper so it does not disclaim twice. */
#define DISCLAIMED_ENV "KE_PEN_HOLD_DISCLAIMED"
/* Test-only: keep the caller's responsibility (and so its Accessibility
 * approval). Setting it gains nothing: the helper then runs with exactly the
 * approval whoever started it already has. */
#define INHERIT_ENV "KE_PEN_HOLD_INHERIT_RESPONSIBILITY"

extern char **environ;
/* libSystem, macOS 10.14+. Declared here because the SDK keeps it private. */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim)
    __attribute__((weak_import));

static hold_machine_t g_machine;
static CFMachPortRef g_tap = NULL;
static CFRunLoopSourceRef g_tap_source = NULL;
static CFRunLoopTimerRef g_hold_timer = NULL;
static CFRunLoopTimerRef g_permission_timer = NULL;
static CFRunLoopTimerRef g_watchdog_timer = NULL;
static unsigned g_watchdog_ticks = 0;
static CGEventRef g_saved_down = NULL;
/* Other-mouse downs the HID system had counted when the pending press began,
 * so a tap reset can tell the same press from a new one. */
static uint32_t g_down_count_at_press = 0;
static CGEventSourceRef g_replay_source = NULL;
static uint32_t g_timer_token = 0;
static uint32_t g_hold_sequence = 0;
static hold_line_reader_t g_reader;
static int g_shutting_down = 0;
static dispatch_source_t g_stdin_source = NULL;
static dispatch_source_t g_parent_source = NULL;
static dispatch_source_t g_signal_sources[3];

static void shutdown_and_exit(int status);
static void wait_for_permission(void);

/* Output is non-blocking: a stalled reader must never stall the run loop the
 * tap callback depends on, so a line that does not fit is dropped. */
static void emit(const char *line, size_t length) {
  ssize_t written;
  if (length == 0) return;
  written = write(STDOUT_FILENO, line, length);
  (void)written;
}

static void emit_error(const char *code) {
  char line[128];
  emit(line, hold_format_error(line, sizeof(line), code));
}

static CGEventTimestamp current_timestamp(void) {
  CGEventRef probe = CGEventCreate(NULL);
  CGEventTimestamp timestamp = 0;
  if (probe != NULL) {
    timestamp = CGEventGetTimestamp(probe);
    CFRelease(probe);
  }
  return timestamp;
}

static void post_copy(CGEventTapProxy proxy, CGEventRef source, CGEventType type) {
  CGEventRef copy = CGEventCreateCopy(source);
  CGEventTimestamp now;
  if (copy == NULL) return;
  CGEventSetType(copy, type);
  if (g_replay_source != NULL) CGEventSetSource(copy, g_replay_source);
  /* An up built from the stored down must not carry the down's pressure. */
  if (type == kCGEventOtherMouseUp) CGEventSetDoubleValueField(copy, kCGMouseEventPressure, 0.0);
  now = current_timestamp();
  if (now != 0) CGEventSetTimestamp(copy, now);
  if (proxy != NULL) {
    /* Inserted right after this tap, ahead of anything still upstream. */
    CGEventTapPostEvent(proxy, copy);
  } else {
    CGEventPost(kCGSessionEventTap, copy);
  }
  CFRelease(copy);
}

static void cancel_hold_timer(void) {
  if (g_hold_timer != NULL) {
    CFRunLoopTimerSetNextFireDate(g_hold_timer, CFAbsoluteTimeGetCurrent() + DISTANT_FUTURE_SECONDS);
  }
}

static void start_hold_timer(void) {
  g_timer_token = g_machine.token;
  if (g_hold_timer != NULL) {
    CFRunLoopTimerSetNextFireDate(g_hold_timer,
                                  CFAbsoluteTimeGetCurrent() + g_machine.threshold_ms / 1000.0);
  }
}

/* Performs a state-machine result in the documented order. */
static void perform(uint32_t actions, CGEventTapProxy proxy, CGEventRef current) {
  if (actions & HOLD_ACT_CANCEL_TIMER) cancel_hold_timer();
  if ((actions & HOLD_ACT_REPLAY_DOWN) && g_saved_down != NULL) {
    post_copy(proxy, g_saved_down, kCGEventOtherMouseDown);
  }
  if ((actions & HOLD_ACT_REPLAY_UP) && g_saved_down != NULL) {
    post_copy(proxy, g_saved_down, kCGEventOtherMouseUp);
  }
  if ((actions & HOLD_ACT_REPLAY_CURRENT) && current != NULL) {
    post_copy(proxy, current, CGEventGetType(current));
  }
  if ((actions & HOLD_ACT_STORE_ORIGIN) && current != NULL) {
    if (g_saved_down != NULL) CFRelease(g_saved_down);
    g_saved_down = CGEventCreateCopy(current);
    g_down_count_at_press =
        CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventOtherMouseDown);
  }
  if (actions & HOLD_ACT_START_TIMER) start_hold_timer();
  if (actions & HOLD_ACT_EMIT_HOLD) {
    char line[96];
    g_hold_sequence += 1;
    emit(line, hold_format_hold(line, sizeof(line), g_hold_sequence));
  }
}

static void remove_tap(void);

/* Middle-button state as the HID system saw it, before any session tap, for
 * deciding what a tap reset means. The helper's own replays are posted at the
 * session level and never show up here. */
static void middle_button_now(int *button_down, int *new_press) {
  uint32_t downs =
      CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventOtherMouseDown);
  *button_down = CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonCenter);
  *new_press = downs != g_down_count_at_press;
}

/* The approval was withdrawn while the tap was running: stop holding anything
 * back, say so, and wait for it to come back. */
static void deactivate_for_permission(void) {
  cancel_hold_timer();
  remove_tap();
  if (g_watchdog_timer != NULL) {
    CFRunLoopTimerInvalidate(g_watchdog_timer);
    CFRelease(g_watchdog_timer);
    g_watchdog_timer = NULL;
  }
  perform(hold_on_tap_reset(&g_machine, 0, 0), NULL, NULL);
  wait_for_permission();
}

/* Re-enables a tap macOS has disabled and settles whatever press was in
 * flight: one that is still held keeps its meaning, anything the tap missed
 * is given back as a click. Returns 1 when the tap had been disabled. */
static int recover_disabled_tap(const char *reason) {
  char line[96];
  int button_down = 0;
  int new_press = 0;
  if (g_tap == NULL || CGEventTapIsEnabled(g_tap)) return 0;
  if (!AXIsProcessTrusted()) {
    deactivate_for_permission();
    return 1;
  }
  CGEventTapEnable(g_tap, true);
  middle_button_now(&button_down, &new_press);
  perform(hold_on_tap_reset(&g_machine, button_down, new_press), NULL, NULL);
  emit(line, hold_format_tap_restored(line, sizeof(line), reason));
  return 1;
}

static CGEventRef tap_callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event,
                               void *context) {
  hold_input_t input;
  uint32_t actions;
  CGPoint location;
  (void)context;

  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    /* A tap the watchdog already re-enabled has nothing left to recover:
     * this notice only arrives with the next event, after the fact. */
    recover_disabled_tap(type == kCGEventTapDisabledByTimeout ? "timeout" : "user-input");
    return event;
  }
  /* Every button other than the middle one leaves untouched, first thing. */
  if (CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber) != MIDDLE_BUTTON) return event;
  if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) == KE_PEN_REPLAY_TAG) return event;

  switch (type) {
    case kCGEventOtherMouseDown: input = HOLD_INPUT_DOWN; break;
    case kCGEventOtherMouseUp: input = HOLD_INPUT_UP; break;
    case kCGEventOtherMouseDragged: input = HOLD_INPUT_DRAG; break;
    default: return event;
  }
  location = CGEventGetLocation(event);
  actions = hold_on_input(&g_machine, input, location.x, location.y);
  perform(actions, proxy, event);
  return (actions & HOLD_ACT_SWALLOW) ? NULL : event;
}

static void hold_timer_fired(CFRunLoopTimerRef timer, void *context) {
  int button_down = 0;
  int new_press = 0;
  (void)timer;
  (void)context;
  /* The release (or a new press) can have gone by unseen while this process
   * was not scheduled, and macOS may have disabled the tap meanwhile. Settle
   * that first; a hold is only reported for the press that is still held. */
  recover_disabled_tap("watchdog");
  if (g_machine.state == HOLD_PENDING && g_timer_token == g_machine.token) {
    middle_button_now(&button_down, &new_press);
    if (!button_down || new_press) {
      perform(hold_on_tap_reset(&g_machine, button_down, new_press), NULL, NULL);
      return;
    }
  }
  perform(hold_on_timer(&g_machine, g_timer_token), NULL, NULL);
}

static int install_tap(void) {
  CGEventMask mask = CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) |
                     CGEventMaskBit(kCGEventOtherMouseDragged);
  if (g_tap != NULL) return 1;
  g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
                           mask, tap_callback, NULL);
  if (g_tap == NULL) return 0;
  g_tap_source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
  if (g_tap_source == NULL) {
    CFMachPortInvalidate(g_tap);
    CFRelease(g_tap);
    g_tap = NULL;
    return 0;
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), g_tap_source, kCFRunLoopCommonModes);
  CGEventTapEnable(g_tap, true);
  return 1;
}

static void remove_tap(void) {
  if (g_tap != NULL) {
    CGEventTapEnable(g_tap, false);
    CFMachPortInvalidate(g_tap);
  }
  if (g_tap_source != NULL) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), g_tap_source, kCFRunLoopCommonModes);
    CFRelease(g_tap_source);
    g_tap_source = NULL;
  }
  if (g_tap != NULL) {
    CFRelease(g_tap);
    g_tap = NULL;
  }
}

/* While the tap is up: re-enable it if macOS disabled it, and notice a
 * withdrawn approval, which does not always tell a running tap. */
static void watchdog_fired(CFRunLoopTimerRef timer, void *context) {
  (void)timer;
  (void)context;
  if (g_tap == NULL) return;
  if (recover_disabled_tap("watchdog")) return;
  g_watchdog_ticks += 1;
  if (g_watchdog_ticks % TRUST_CHECK_EVERY_TICKS == 0 && !AXIsProcessTrusted()) {
    deactivate_for_permission();
  }
}

static void start_watchdog(void) {
  CFRunLoopTimerContext timer_context = {0, NULL, NULL, NULL, NULL};
  if (g_watchdog_timer != NULL) return;
  g_watchdog_timer = CFRunLoopTimerCreate(kCFAllocatorDefault,
                                          CFAbsoluteTimeGetCurrent() + WATCHDOG_SECONDS,
                                          WATCHDOG_SECONDS, 0, 0, watchdog_fired, &timer_context);
  CFRunLoopAddTimer(CFRunLoopGetMain(), g_watchdog_timer, kCFRunLoopCommonModes);
}

/* The helper's own Accessibility approval is what allows an active tap. With
 * the approval granted, a tap that still cannot be created is a real failure:
 * the helper exits so KE Pen's supervisor backs off and, after repeated
 * failures, offers a restart instead of asking for a permission that is
 * already there. */
static int try_activate(void) {
  char line[128];
  if (!AXIsProcessTrusted()) return 0;
  if (!install_tap()) {
    emit_error("tap-create-failed");
    shutdown_and_exit(1);
    return 0;
  }
  start_watchdog();
  emit(line, hold_format_active(line, sizeof(line)));
  return 1;
}

static void stop_permission_timer(void) {
  if (g_permission_timer == NULL) return;
  CFRunLoopTimerInvalidate(g_permission_timer);
  CFRelease(g_permission_timer);
  g_permission_timer = NULL;
}

static void permission_timer_fired(CFRunLoopTimerRef timer, void *context) {
  (void)timer;
  (void)context;
  if (try_activate()) stop_permission_timer();
}

static void wait_for_permission(void) {
  char line[128];
  CFRunLoopTimerContext timer_context = {0, NULL, NULL, NULL, NULL};
  emit(line, hold_format_needs_permission(line, sizeof(line), "accessibility"));
  if (g_permission_timer != NULL) return;
  g_permission_timer = CFRunLoopTimerCreate(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + PERMISSION_POLL_SECONDS,
      PERMISSION_POLL_SECONDS, 0, 0, permission_timer_fired, &timer_context);
  CFRunLoopAddTimer(CFRunLoopGetMain(), g_permission_timer, kCFRunLoopCommonModes);
}

/* Shows macOS's own Accessibility alert for this helper, which also adds it
 * to System Settings › Privacy & Security › Accessibility. KE Pen sends this
 * only after the person chose to set hold to capture up. */
static void request_permission_prompt(void) {
  const void *keys[] = {kAXTrustedCheckOptionPrompt};
  const void *values[] = {kCFBooleanTrue};
  CFDictionaryRef options;
  if (g_tap != NULL) return;
  options = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                               &kCFTypeDictionaryValueCallBacks);
  if (options == NULL) return;
  if (AXIsProcessTrustedWithOptions(options) && try_activate()) stop_permission_timer();
  CFRelease(options);
}

static void handle_line(const char *line, size_t length, int too_long, void *context) {
  hold_command_t command;
  int result;
  (void)context;
  if (too_long) {
    emit_error(hold_parse_error_code(HOLD_PARSE_TOO_LONG));
    return;
  }
  result = hold_parse_command(line, length, &command);
  if (result == HOLD_PARSE_EMPTY) return;
  if (result != HOLD_PARSE_OK) {
    emit_error(hold_parse_error_code(result));
    return;
  }
  switch (command.kind) {
    case HOLD_CMD_CONFIG:
      hold_set_threshold(&g_machine, command.threshold_ms);
      break;
    case HOLD_CMD_ARM:
      perform(hold_set_armed(&g_machine, 1), NULL, NULL);
      break;
    case HOLD_CMD_DISARM:
      perform(hold_set_armed(&g_machine, 0), NULL, NULL);
      break;
    case HOLD_CMD_PROMPT:
      request_permission_prompt();
      break;
    case HOLD_CMD_QUIT:
      shutdown_and_exit(0);
      break;
  }
}

static void read_stdin(void) {
  char buffer[512];
  ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
  if (count > 0) {
    hold_line_reader_feed(&g_reader, buffer, (size_t)count, handle_line, NULL);
    return;
  }
  if (count < 0 && (errno == EAGAIN || errno == EINTR)) return;
  /* KE Pen closed the pipe or went away: stop swallowing anything. */
  shutdown_and_exit(0);
}

static void shutdown_and_exit(int status) {
  uint32_t actions;
  if (g_shutting_down) return;
  g_shutting_down = 1;
  cancel_hold_timer();
  /* Take the tap out first so nothing else is swallowed, then give back a
   * click still being held. Its up would otherwise never find its down. */
  remove_tap();
  actions = hold_on_shutdown(&g_machine);
  perform(actions & (HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP), NULL, NULL);
  if (actions & HOLD_ACT_REPLAY_DOWN) usleep(20000);
  if (g_saved_down != NULL) {
    CFRelease(g_saved_down);
    g_saved_down = NULL;
  }
  exit(status);
}

static void watch_signal(int index, int signal_number) {
  dispatch_source_t source;
  signal(signal_number, SIG_IGN);
  source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signal_number, 0,
                                  dispatch_get_main_queue());
  dispatch_source_set_event_handler(source, ^{
    shutdown_and_exit(0);
  });
  dispatch_resume(source);
  g_signal_sources[index] = source;
}

/*
 * Makes this helper its own "responsible process" for macOS privacy checks by
 * re-executing itself in place (same pid, same pipes) with the disclaim
 * attribute. Fails closed: a helper that cannot disclaim never runs under
 * KE Pen's identity.
 */
static void disclaim_responsibility(char **argv) {
  char path[4096];
  uint32_t size = sizeof(path);
  posix_spawnattr_t attributes;
  int result;
  if (getenv(INHERIT_ENV) != NULL || getenv(DISCLAIMED_ENV) != NULL) return;
  if (responsibility_spawnattrs_setdisclaim == NULL || _NSGetExecutablePath(path, &size) != 0) {
    emit_error("disclaim-unavailable");
    exit(1);
  }
  if (setenv(DISCLAIMED_ENV, "1", 1) != 0 || posix_spawnattr_init(&attributes) != 0) exit(1);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
  if (responsibility_spawnattrs_setdisclaim(&attributes, 1) != 0) {
    emit_error("disclaim-failed");
    exit(1);
  }
  /* Only returns when the exec failed. */
  result = posix_spawn(NULL, path, NULL, &attributes, argv, environ);
  (void)result;
  posix_spawnattr_destroy(&attributes);
  emit_error("disclaim-failed");
  exit(1);
}

static void set_nonblocking(int descriptor) {
  int flags;
  if (isatty(descriptor)) return;
  flags = fcntl(descriptor, F_GETFL, 0);
  if (flags >= 0) fcntl(descriptor, F_SETFL, flags | O_NONBLOCK);
}

int main(int argc, char **argv) {
  char line[256];
  pid_t parent;
  (void)environ;
  CFRunLoopTimerContext timer_context = {0, NULL, NULL, NULL, NULL};

  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    size_t length = hold_format_version(line, sizeof(line), KE_PEN_VERSION);
    fwrite(line, 1, length, stdout);
    return 0;
  }
  if (argc != 1) {
    fprintf(stderr, "usage: %s [--version]\n", HOLD_HELPER_NAME);
    return 64;
  }

  parent = getppid();
  if (parent <= 1) return 0; /* already orphaned: never swallow for nobody */

  disclaim_responsibility(argv);
  signal(SIGPIPE, SIG_IGN);
  set_nonblocking(STDOUT_FILENO);
  set_nonblocking(STDIN_FILENO);
  hold_init(&g_machine, SLOP_POINTS);
  hold_line_reader_init(&g_reader);
  g_replay_source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
  if (g_replay_source == NULL) {
    emit_error("event-source-failed");
    return 1;
  }
  CGEventSourceSetUserData(g_replay_source, KE_PEN_REPLAY_TAG);

  /* One long-lived timer, re-dated per press, so a one-shot timer is never
   * invalidated out from under the state machine. */
  g_hold_timer = CFRunLoopTimerCreate(kCFAllocatorDefault,
                                      CFAbsoluteTimeGetCurrent() + DISTANT_FUTURE_SECONDS,
                                      DISTANT_FUTURE_SECONDS, 0, 0, hold_timer_fired,
                                      &timer_context);
  CFRunLoopAddTimer(CFRunLoopGetMain(), g_hold_timer, kCFRunLoopCommonModes);

  g_stdin_source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)STDIN_FILENO, 0,
                                          dispatch_get_main_queue());
  dispatch_source_set_event_handler(g_stdin_source, ^{
    read_stdin();
  });
  dispatch_resume(g_stdin_source);

  g_parent_source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)parent,
                                           DISPATCH_PROC_EXIT, dispatch_get_main_queue());
  dispatch_source_set_event_handler(g_parent_source, ^{
    shutdown_and_exit(0);
  });
  dispatch_resume(g_parent_source);

  watch_signal(0, SIGTERM);
  watch_signal(1, SIGINT);
  watch_signal(2, SIGHUP);

  emit(line, hold_format_ready(line, sizeof(line), KE_PEN_VERSION, "darwin"));
  if (!try_activate()) wait_for_permission();

  CFRunLoopRun();
  shutdown_and_exit(0);
  return 0;
}
