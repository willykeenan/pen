/*
 * ke-pen-hold-helper for Windows.
 *
 * A low-level mouse hook (WH_MOUSE_LL) that only acts on the middle button.
 * While KE Pen has armed it, WM_MBUTTONDOWN is held back so an open menu in
 * another app never sees it. Released quickly, the click is re-sent at its
 * original position; held past the threshold, KE Pen is told to freeze the
 * screen and open its selector, and the matching up is swallowed.
 *
 * Pointer moves are only looked at while a middle press is pending, to tell a
 * drag from a still hold, and are never swallowed: on Windows a swallowed move
 * would freeze the cursor.
 *
 * The hook procedure stays O(1). Re-sending input and writing to stdout happen
 * on the message loop and a writer thread, never inside the hook, because
 * Windows silently removes hooks that exceed LowLevelHooksTimeout. A hook can
 * only be removed that way while this thread is not answering, so a heartbeat
 * timer watches for such stalls: after one, the hook is re-installed and a
 * press the helper may have lost track of is given back. The hook is also
 * re-installed every 30 seconds whatever the state, and a press that has seen
 * no input for far longer than the hold threshold is reset.
 *
 * Input sent into a window running elevated is blocked by UIPI, so a quick
 * middle click over an administrator window cannot be given back.
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>

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

/* "KPHL" in dwExtraInfo marks input this helper sends, so the hook lets its
 * own replays through and they can never loop. */
#define KE_PEN_REPLAY_TAG ((ULONG_PTR)0x4B50484CUL)
#define SLOP_PIXELS 8.0
#define HOLD_TIMER_ID 1
#define REHOOK_TIMER_ID 2
#define HEARTBEAT_TIMER_ID 3
#define REHOOK_INTERVAL_MS (30u * 1000u)
#define HEARTBEAT_INTERVAL_MS 200u
/* A gap this long between heartbeats means this thread stopped answering for
 * long enough that Windows may have dropped the hook. */
#define STALL_GAP_MS 500u
/* A non-idle press with no hook call for this long past its threshold is stale. */
#define STALE_PRESS_SLACK_MS 2000u
#define WM_KEPEN_WORK (WM_APP + 1)
#define WM_KEPEN_COMMAND (WM_APP + 2)
#define WM_KEPEN_SHUTDOWN (WM_APP + 3)
#define WORK_SLOTS 64u
#define OUT_SLOTS 32u
#define OUT_LINE 192u

typedef struct {
  uint32_t actions;
  POINT replay_at;
  POINT current_at;
  hold_input_t current;
} work_t;

static hold_machine_t g_machine;
static HHOOK g_hook = NULL;
static HWND g_window = NULL;
static POINT g_origin;
static uint32_t g_timer_token = 0;
static ULONGLONG g_last_beat = 0;
static ULONGLONG g_last_hook_call = 0;
static uint32_t g_hold_sequence = 0;
static int g_shutting_down = 0;

/* Only the hook thread touches the work ring: the hook procedure runs on the
 * thread that installed it, inside its own message loop. */
static work_t g_work[WORK_SLOTS];
static unsigned g_work_head = 0;
static unsigned g_work_tail = 0;

static CRITICAL_SECTION g_out_lock;
static HANDLE g_out_event = NULL;
static char g_out[OUT_SLOTS][OUT_LINE];
static size_t g_out_length[OUT_SLOTS];
static unsigned g_out_head = 0;
static unsigned g_out_tail = 0;
static volatile LONG g_out_broken = 0;

static void emit(const char *line, size_t length) {
  if (length == 0 || length >= OUT_LINE) return;
  EnterCriticalSection(&g_out_lock);
  if (g_out_tail - g_out_head < OUT_SLOTS) {
    unsigned slot = g_out_tail % OUT_SLOTS;
    memcpy(g_out[slot], line, length);
    g_out_length[slot] = length;
    g_out_tail++;
  }
  LeaveCriticalSection(&g_out_lock);
  SetEvent(g_out_event);
}

static void emit_error(const char *code) {
  char line[128];
  emit(line, hold_format_error(line, sizeof(line), code));
}

/* Writes queued lines; returns when the queue is empty or stdout is gone. */
static void drain_output(void) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  for (;;) {
    char line[OUT_LINE];
    size_t length = 0;
    DWORD written = 0;
    EnterCriticalSection(&g_out_lock);
    if (g_out_head != g_out_tail) {
      unsigned slot = g_out_head % OUT_SLOTS;
      length = g_out_length[slot];
      memcpy(line, g_out[slot], length);
      g_out_head++;
    }
    LeaveCriticalSection(&g_out_lock);
    if (length == 0) return;
    if (g_out_broken) continue;
    if (!WriteFile(out, line, (DWORD)length, &written, NULL)) InterlockedExchange(&g_out_broken, 1);
  }
}

static DWORD WINAPI writer_thread(LPVOID unused) {
  (void)unused;
  for (;;) {
    WaitForSingleObject(g_out_event, INFINITE);
    drain_output();
  }
}

/* All replays for one action set go out as a single SendInput batch, which
 * Windows inserts into the input stream without anything interleaved. The
 * pointer is only moved when it is farther than the drag slop from where a
 * replayed event belongs, and is always put back where it is now. */
typedef struct {
  INPUT items[8];
  UINT count;
} batch_t;

static void add_button(batch_t *batch, DWORD flag) {
  INPUT *input;
  if (batch->count >= 8) return;
  input = &batch->items[batch->count++];
  memset(input, 0, sizeof(*input));
  input->type = INPUT_MOUSE;
  input->mi.dwFlags = flag;
  input->mi.dwExtraInfo = KE_PEN_REPLAY_TAG;
}

static void add_move(batch_t *batch, POINT at) {
  INPUT *input;
  int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (batch->count >= 8 || width < 2 || height < 2) return;
  input = &batch->items[batch->count++];
  memset(input, 0, sizeof(*input));
  input->type = INPUT_MOUSE;
  input->mi.dx = (LONG)(((double)(at.x - left) * 65535.0) / (double)(width - 1) + 0.5);
  input->mi.dy = (LONG)(((double)(at.y - top) * 65535.0) / (double)(height - 1) + 0.5);
  input->mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  input->mi.dwExtraInfo = KE_PEN_REPLAY_TAG;
}

static int farther_than_slop(POINT a, POINT b) {
  double dx = (double)(a.x - b.x);
  double dy = (double)(a.y - b.y);
  return dx * dx + dy * dy > SLOP_PIXELS * SLOP_PIXELS;
}

static void perform_replays(const work_t *work) {
  batch_t batch;
  POINT cursor;
  int have_cursor = GetCursorPos(&cursor) ? 1 : 0;
  int away = 0; /* the pointer was moved off where it is now */
  batch.count = 0;
  if (work->actions & (HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP)) {
    if (have_cursor && farther_than_slop(cursor, work->replay_at)) {
      add_move(&batch, work->replay_at);
      away = 1;
    }
    if (work->actions & HOLD_ACT_REPLAY_DOWN) add_button(&batch, MOUSEEVENTF_MIDDLEDOWN);
    if (work->actions & HOLD_ACT_REPLAY_UP) add_button(&batch, MOUSEEVENTF_MIDDLEUP);
  }
  if (work->actions & HOLD_ACT_REPLAY_CURRENT) {
    if (work->current == HOLD_INPUT_DOWN) {
      if (away || (have_cursor && farther_than_slop(cursor, work->current_at))) {
        add_move(&batch, work->current_at);
        away = have_cursor && farther_than_slop(cursor, work->current_at);
      }
      add_button(&batch, MOUSEEVENTF_MIDDLEDOWN);
    } else if (work->current == HOLD_INPUT_UP) {
      if (away) {
        add_move(&batch, cursor);
        away = 0;
      }
      add_button(&batch, MOUSEEVENTF_MIDDLEUP);
    }
  }
  /* A drag handed back starts where the press did and continues from the
   * pointer's position at replay time, never from a stale one. */
  if (away && have_cursor) add_move(&batch, cursor);
  if (batch.count > 0) SendInput(batch.count, batch.items, sizeof(INPUT));
}

static void queue_work(uint32_t actions, POINT replay_at, POINT current_at, hold_input_t current) {
  work_t *work;
  if (g_work_tail - g_work_head >= WORK_SLOTS) return;
  work = &g_work[g_work_tail % WORK_SLOTS];
  work->actions = actions;
  work->replay_at = replay_at;
  work->current_at = current_at;
  work->current = current;
  g_work_tail++;
  PostMessageW(g_window, WM_KEPEN_WORK, 0, 0);
}

static void drain_work(void) {
  while (g_work_head != g_work_tail) {
    work_t work = g_work[g_work_head % WORK_SLOTS];
    g_work_head++;
    perform_replays(&work);
  }
}

static LRESULT CALLBACK mouse_hook(int code, WPARAM message, LPARAM lparam) {
  const MSLLHOOKSTRUCT *info;
  hold_input_t input;
  uint32_t actions;
  POINT replay_at;
  if (code != HC_ACTION) return CallNextHookEx(NULL, code, message, lparam);
  g_last_hook_call = GetTickCount64();
  /* Only the middle button, and moves while a middle press is pending. */
  if (message != WM_MBUTTONDOWN && message != WM_MBUTTONUP && message != WM_MOUSEMOVE) {
    return CallNextHookEx(NULL, code, message, lparam);
  }
  if (message == WM_MOUSEMOVE && g_machine.state != HOLD_PENDING) {
    return CallNextHookEx(NULL, code, message, lparam);
  }
  info = (const MSLLHOOKSTRUCT *)lparam;
  if ((info->flags & LLMHF_INJECTED) && info->dwExtraInfo == KE_PEN_REPLAY_TAG) {
    return CallNextHookEx(NULL, code, message, lparam);
  }
  input = message == WM_MBUTTONDOWN ? HOLD_INPUT_DOWN
          : message == WM_MBUTTONUP ? HOLD_INPUT_UP
                                    : HOLD_INPUT_DRAG;
  replay_at = g_origin;
  actions = hold_on_input(&g_machine, input, (double)info->pt.x, (double)info->pt.y);
  if (input == HOLD_INPUT_DRAG) {
    actions &= ~(uint32_t)(HOLD_ACT_SWALLOW | HOLD_ACT_REPLAY_CURRENT);
  }
  if (actions & HOLD_ACT_CANCEL_TIMER) KillTimer(g_window, HOLD_TIMER_ID);
  if (actions & (HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP | HOLD_ACT_REPLAY_CURRENT)) {
    queue_work(actions, replay_at, info->pt, input);
  }
  if (actions & HOLD_ACT_STORE_ORIGIN) g_origin = info->pt;
  if (actions & HOLD_ACT_START_TIMER) {
    g_timer_token = g_machine.token;
    SetTimer(g_window, HOLD_TIMER_ID, g_machine.threshold_ms, NULL);
  }
  if (actions & HOLD_ACT_SWALLOW) return 1;
  return CallNextHookEx(NULL, code, message, lparam);
}

static void perform_outside_hook(uint32_t actions) {
  work_t work;
  if (actions & HOLD_ACT_CANCEL_TIMER) KillTimer(g_window, HOLD_TIMER_ID);
  memset(&work, 0, sizeof(work));
  work.actions = actions & (HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP);
  work.replay_at = g_origin;
  work.current = HOLD_INPUT_UP; /* no current event outside the hook */
  if (work.actions) perform_replays(&work);
  if (actions & HOLD_ACT_EMIT_HOLD) {
    char line[96];
    g_hold_sequence++;
    emit(line, hold_format_hold(line, sizeof(line), g_hold_sequence));
  }
}

static int install_hook(void) {
  HHOOK fresh = SetWindowsHookExW(WH_MOUSE_LL, mouse_hook, GetModuleHandleW(NULL), 0);
  if (fresh == NULL) return 0;
  /* No hook call can run between these two lines: hook procedures are only
   * invoked from this thread's message loop. */
  if (g_hook != NULL) UnhookWindowsHookEx(g_hook);
  g_hook = fresh;
  return 1;
}

/* The hook may have been dropped, and with it any input since: re-install it
 * and give back whatever press the machine was still tracking. */
static void recover_after_hook_loss(const char *reason) {
  char line[96];
  if (!install_hook()) emit_error("hook-reinstall-failed");
  if (g_machine.state != HOLD_IDLE) perform_outside_hook(hold_on_tap_reset(&g_machine, 0, 0));
  emit(line, hold_format_tap_restored(line, sizeof(line), reason));
}

/* Returns 1 when this thread stopped answering for long enough that Windows
 * may have removed the hook, after recovering from it. */
static int check_for_stall(const char *reason) {
  ULONGLONG now = GetTickCount64();
  ULONGLONG gap = now - g_last_beat;
  g_last_beat = now;
  if (gap <= HEARTBEAT_INTERVAL_MS + STALL_GAP_MS) return 0;
  recover_after_hook_loss(reason);
  return 1;
}

static void shutdown_and_exit(int status) {
  uint32_t actions;
  if (g_shutting_down) return;
  g_shutting_down = 1;
  KillTimer(g_window, HOLD_TIMER_ID);
  if (g_hook != NULL) {
    UnhookWindowsHookEx(g_hook);
    g_hook = NULL;
  }
  drain_work();
  /* Give back a click still being held, then stop. */
  actions = hold_on_shutdown(&g_machine);
  perform_outside_hook(actions & (HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP));
  drain_output();
  ExitProcess((UINT)status);
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_TIMER:
      if (wparam == HOLD_TIMER_ID) {
        KillTimer(window, HOLD_TIMER_ID);
        /* A stall since the last heartbeat may have cost the hook, and with
         * it the release: recover instead of reporting a hold nobody made. */
        if (!check_for_stall("stall")) perform_outside_hook(hold_on_timer(&g_machine, g_timer_token));
      } else if (wparam == HEARTBEAT_TIMER_ID) {
        check_for_stall("stall");
      } else if (wparam == REHOOK_TIMER_ID) {
        ULONGLONG quiet = GetTickCount64() - g_last_hook_call;
        if (!install_hook()) emit_error("hook-reinstall-failed");
        if (g_machine.state != HOLD_IDLE && quiet > g_machine.threshold_ms + STALE_PRESS_SLACK_MS) {
          recover_after_hook_loss("stale");
        }
      }
      return 0;
    case WM_KEPEN_WORK:
      drain_work();
      return 0;
    case WM_KEPEN_COMMAND:
      switch ((hold_command_kind_t)wparam) {
        case HOLD_CMD_CONFIG:
          hold_set_threshold(&g_machine, (long)lparam);
          break;
        case HOLD_CMD_ARM:
          perform_outside_hook(hold_set_armed(&g_machine, 1));
          break;
        case HOLD_CMD_DISARM:
          perform_outside_hook(hold_set_armed(&g_machine, 0));
          break;
        case HOLD_CMD_PROMPT:
          /* Windows asks for no permission; nothing to show. */
          break;
        case HOLD_CMD_QUIT:
          shutdown_and_exit(0);
          break;
      }
      return 0;
    case WM_KEPEN_SHUTDOWN:
      shutdown_and_exit(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
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
  PostMessageW(g_window, WM_KEPEN_COMMAND, (WPARAM)command.kind, (LPARAM)command.threshold_ms);
}

static DWORD WINAPI stdin_thread(LPVOID unused) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  hold_line_reader_t reader;
  char buffer[512];
  DWORD count = 0;
  (void)unused;
  hold_line_reader_init(&reader);
  for (;;) {
    if (!ReadFile(in, buffer, (DWORD)sizeof(buffer), &count, NULL) || count == 0) break;
    hold_line_reader_feed(&reader, buffer, (size_t)count, handle_line, NULL);
  }
  /* KE Pen closed the pipe or went away: stop swallowing anything. */
  PostMessageW(g_window, WM_KEPEN_SHUTDOWN, 0, 0);
  return 0;
}

static DWORD parent_process_id(void) {
  DWORD self = GetCurrentProcessId();
  DWORD parent = 0;
  PROCESSENTRY32W entry;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  memset(&entry, 0, sizeof(entry));
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == self) {
        parent = entry.th32ParentProcessID;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return parent;
}

static DWORD WINAPI parent_thread(LPVOID handle) {
  WaitForSingleObject((HANDLE)handle, INFINITE);
  PostMessageW(g_window, WM_KEPEN_SHUTDOWN, 0, 0);
  return 0;
}

typedef BOOL(WINAPI *set_dpi_context_fn)(HANDLE);

static void use_physical_pixels(void) {
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  FARPROC address = user32 ? GetProcAddress(user32, "SetProcessDpiAwarenessContext") : NULL;
  if (address != NULL) {
    set_dpi_context_fn set_context;
    memcpy(&set_context, &address, sizeof(set_context));
    /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */
    set_context((HANDLE)(LONG_PTR)-4);
  }
}

int main(int argc, char **argv) {
  char line[256];
  WNDCLASSW window_class;
  HANDLE thread;
  DWORD parent;
  MSG message;

  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    size_t length = hold_format_version(line, sizeof(line), KE_PEN_VERSION);
    fwrite(line, 1, length, stdout);
    return 0;
  }
  if (argc != 1) {
    fprintf(stderr, "usage: %s [--version]\n", HOLD_HELPER_NAME);
    return 64;
  }

  use_physical_pixels();
  hold_init(&g_machine, SLOP_PIXELS);
  InitializeCriticalSection(&g_out_lock);
  g_out_event = CreateEventW(NULL, FALSE, FALSE, NULL);
  if (g_out_event == NULL) return 1;
  thread = CreateThread(NULL, 0, writer_thread, NULL, 0, NULL);
  if (thread != NULL) CloseHandle(thread);

  memset(&window_class, 0, sizeof(window_class));
  window_class.lpfnWndProc = window_proc;
  window_class.hInstance = GetModuleHandleW(NULL);
  window_class.lpszClassName = L"KEPenHoldHelper";
  RegisterClassW(&window_class);
  g_window = CreateWindowExW(0, window_class.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL,
                             window_class.hInstance, NULL);
  if (g_window == NULL) {
    emit_error("window-create-failed");
    drain_output();
    return 1;
  }

  emit(line, hold_format_ready(line, sizeof(line), KE_PEN_VERSION, "win32"));
  if (!install_hook()) {
    emit_error("hook-install-failed");
    drain_output();
    return 1;
  }
  emit(line, hold_format_active(line, sizeof(line)));
  g_last_beat = GetTickCount64();
  g_last_hook_call = g_last_beat;
  SetTimer(g_window, REHOOK_TIMER_ID, REHOOK_INTERVAL_MS, NULL);
  SetTimer(g_window, HEARTBEAT_TIMER_ID, HEARTBEAT_INTERVAL_MS, NULL);

  thread = CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);
  if (thread == NULL) shutdown_and_exit(1);
  CloseHandle(thread);

  parent = parent_process_id();
  if (parent != 0) {
    HANDLE parent_handle = OpenProcess(SYNCHRONIZE, FALSE, parent);
    if (parent_handle != NULL) {
      thread = CreateThread(NULL, 0, parent_thread, parent_handle, 0, NULL);
      if (thread != NULL) CloseHandle(thread);
    }
  }

  while (GetMessageW(&message, NULL, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  shutdown_and_exit(0);
  return 0;
}
