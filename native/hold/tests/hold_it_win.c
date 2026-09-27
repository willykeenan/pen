/*
 * Synthetic Windows integration test for ke-pen-hold-helper. Test-only: never
 * packaged. It drives the real helper binary with SendInput middle-button
 * events aimed at a small sink window and counts what that window receives,
 * which is exactly what an application under the pointer would get.
 *
 *   hold_it_win <helper.exe> <evidence.json>
 *
 * Exit status: 0 pass · 1 fail · 77 this session cannot inject input (the
 * disarmed control click never arrived), so the caller decides whether a
 * skip is acceptable.
 *
 * Every event this test sends carries its own tag in dwExtraInfo; the helper
 * re-sends clicks with its tag, so the two are never confused. No positions
 * are written to the evidence.
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TEST_TAG ((ULONG_PTR)0x4B50544EUL) /* "KPTN" */
#define THRESHOLD_MS 300
#define SINK_SIZE 160

static HWND g_sink = NULL;
static volatile LONG g_sink_down = 0;
static volatile LONG g_sink_up = 0;
static volatile LONG g_holds = 0;
static volatile LONG g_ready = 0;
static volatile LONG g_active = 0;
static volatile LONG g_restored = 0;
static HANDLE g_helper_process = NULL;
static HANDLE g_helper_stdin = NULL;
static DWORD g_helper_pid = 0;
static POINT g_target;
static int g_all_passed = 1;
static FILE *g_evidence = NULL;
static int g_first_result = 1;

static LRESULT CALLBACK sink_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_MBUTTONDOWN:
      InterlockedIncrement(&g_sink_down);
      return 0;
    case WM_MBUTTONUP:
      InterlockedIncrement(&g_sink_up);
      return 0;
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATE;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

static void pump_ms(DWORD milliseconds) {
  ULONGLONG end = GetTickCount64() + milliseconds;
  for (;;) {
    MSG message;
    ULONGLONG now;
    while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    now = GetTickCount64();
    if (now >= end) break;
    MsgWaitForMultipleObjects(0, NULL, FALSE, (DWORD)((end - now) < 10 ? (end - now) : 10), QS_ALLINPUT);
  }
}

static void send_one(DWORD flags, LONG dx, LONG dy) {
  INPUT input;
  memset(&input, 0, sizeof(input));
  input.type = INPUT_MOUSE;
  input.mi.dx = dx;
  input.mi.dy = dy;
  input.mi.dwFlags = flags;
  input.mi.dwExtraInfo = TEST_TAG;
  SendInput(1, &input, sizeof(INPUT));
}

static void move_to(POINT at) {
  int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  LONG dx = (LONG)(((double)(at.x - left) * 65535.0) / (double)(width - 1) + 0.5);
  LONG dy = (LONG)(((double)(at.y - top) * 65535.0) / (double)(height - 1) + 0.5);
  send_one(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy);
}

static POINT offset(LONG dx, LONG dy) {
  POINT point;
  point.x = g_target.x + dx;
  point.y = g_target.y + dy;
  return point;
}

static void middle_down(void) { send_one(MOUSEEVENTF_MIDDLEDOWN, 0, 0); }
static void middle_up(void) { send_one(MOUSEEVENTF_MIDDLEUP, 0, 0); }

static void send_command(const char *line) {
  DWORD written = 0;
  if (g_helper_stdin != NULL) WriteFile(g_helper_stdin, line, (DWORD)strlen(line), &written, NULL);
}

static DWORD WINAPI reader_thread(LPVOID handle) {
  char buffer[512];
  char line[1100];
  size_t used = 0;
  DWORD count = 0;
  while (ReadFile((HANDLE)handle, buffer, (DWORD)sizeof(buffer), &count, NULL) && count > 0) {
    DWORD i;
    for (i = 0; i < count; i++) {
      if (buffer[i] == '\n') {
        line[used] = '\0';
        if (strstr(line, "\"type\":\"hold\"")) InterlockedIncrement(&g_holds);
        if (strstr(line, "\"type\":\"ready\"")) InterlockedExchange(&g_ready, 1);
        if (strstr(line, "\"type\":\"active\"")) InterlockedExchange(&g_active, 1);
        if (strstr(line, "\"type\":\"tap-restored\"")) InterlockedIncrement(&g_restored);
        used = 0;
      } else if (used < sizeof(line) - 1) {
        line[used++] = buffer[i];
      }
    }
  }
  return 0;
}

static int start_helper(const char *helper) {
  SECURITY_ATTRIBUTES attributes;
  HANDLE out_read, out_write, in_read, in_write;
  STARTUPINFOA startup;
  PROCESS_INFORMATION process;
  char command_line[1024];
  HANDLE thread;
  memset(&attributes, 0, sizeof(attributes));
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;
  if (!CreatePipe(&out_read, &out_write, &attributes, 0)) return 0;
  if (!CreatePipe(&in_read, &in_write, &attributes, 0)) return 0;
  SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(in_write, HANDLE_FLAG_INHERIT, 0);
  memset(&startup, 0, sizeof(startup));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = in_read;
  startup.hStdOutput = out_write;
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  snprintf(command_line, sizeof(command_line), "\"%s\"", helper);
  memset(&process, 0, sizeof(process));
  InterlockedExchange(&g_ready, 0);
  InterlockedExchange(&g_active, 0);
  if (!CreateProcessA(helper, command_line, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup,
                      &process)) {
    return 0;
  }
  CloseHandle(in_read);
  CloseHandle(out_write);
  CloseHandle(process.hThread);
  g_helper_process = process.hProcess;
  g_helper_pid = process.dwProcessId;
  g_helper_stdin = in_write;
  thread = CreateThread(NULL, 0, reader_thread, out_read, 0, NULL);
  if (thread != NULL) CloseHandle(thread);
  return 1;
}

static int wait_active(DWORD timeout_ms) {
  ULONGLONG end = GetTickCount64() + timeout_ms;
  while (GetTickCount64() < end) {
    if (g_active) return 1;
    pump_ms(20);
  }
  return g_active != 0;
}

static int wait_exit(DWORD timeout_ms, DWORD *code) {
  ULONGLONG end = GetTickCount64() + timeout_ms;
  while (GetTickCount64() < end) {
    if (WaitForSingleObject(g_helper_process, 0) == WAIT_OBJECT_0) {
      if (code) GetExitCodeProcess(g_helper_process, code);
      return 1;
    }
    pump_ms(20);
  }
  return 0;
}

static void stop_helper(void) {
  if (g_helper_stdin != NULL) {
    CloseHandle(g_helper_stdin);
    g_helper_stdin = NULL;
  }
  if (g_helper_process != NULL) {
    if (!wait_exit(1500, NULL)) TerminateProcess(g_helper_process, 1);
    CloseHandle(g_helper_process);
    g_helper_process = NULL;
  }
}

static void configure(int arm) {
  char line[96];
  snprintf(line, sizeof(line), "{\"cmd\":\"config\",\"thresholdMs\":%d}\n", THRESHOLD_MS);
  send_command(line);
  send_command(arm ? "{\"cmd\":\"arm\"}\n" : "{\"cmd\":\"disarm\"}\n");
  pump_ms(80);
}

static void suspend_helper(int suspend) {
  THREADENTRY32 entry;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return;
  memset(&entry, 0, sizeof(entry));
  entry.dwSize = sizeof(entry);
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID == g_helper_pid) {
        HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME, FALSE, entry.th32ThreadID);
        if (thread != NULL) {
          if (suspend) SuspendThread(thread);
          else ResumeThread(thread);
          CloseHandle(thread);
        }
      }
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
}

static void reset_counts(void) {
  InterlockedExchange(&g_sink_down, 0);
  InterlockedExchange(&g_sink_up, 0);
  InterlockedExchange(&g_holds, 0);
  InterlockedExchange(&g_restored, 0);
}

static int cursor_near(POINT expected, LONG tolerance) {
  POINT now;
  if (!GetCursorPos(&now)) return 0;
  return labs(now.x - expected.x) <= tolerance && labs(now.y - expected.y) <= tolerance;
}

static void record(const char *name, int passed, const char *facts_format, ...) {
  va_list args;
  printf("%s %s\n", passed ? "ok  " : "FAIL", name);
  fflush(stdout);
  if (!passed) g_all_passed = 0;
  if (g_evidence == NULL) return;
  fprintf(g_evidence, "%s\n    {\"scenario\": \"%s\", \"passed\": %s", g_first_result ? "" : ",", name,
          passed ? "true" : "false");
  if (facts_format != NULL && facts_format[0] != '\0') {
    fprintf(g_evidence, ", ");
    va_start(args, facts_format);
    vfprintf(g_evidence, facts_format, args);
    va_end(args);
  }
  fprintf(g_evidence, "}");
  g_first_result = 0;
}

static void scenario_short_click(void) {
  LONG downs, holds;
  reset_counts();
  move_to(g_target);
  pump_ms(40);
  middle_down();
  pump_ms(80);
  /* Held back: nothing has reached the window yet. */
  downs = g_sink_down;
  middle_up();
  pump_ms(400);
  holds = g_holds;
  record("short-click-replayed-after-release",
         downs == 0 && g_sink_down == 1 && g_sink_up == 1 && holds == 0 && cursor_near(g_target, 2),
         "\"downsBeforeRelease\": %ld, \"deliveredDowns\": %ld, \"deliveredUps\": %ld, \"holds\": %ld, "
         "\"cursorLeftInPlace\": %s",
         (long)downs, (long)g_sink_down, (long)g_sink_up, (long)holds,
         cursor_near(g_target, 2) ? "true" : "false");
}

static void scenario_long_hold(void) {
  ULONGLONG pressed, fired = 0;
  reset_counts();
  move_to(g_target);
  pump_ms(40);
  pressed = GetTickCount64();
  middle_down();
  while (GetTickCount64() - pressed < 800) {
    pump_ms(5);
    if (fired == 0 && g_holds > 0) fired = GetTickCount64();
  }
  middle_up();
  pump_ms(300);
  {
    long hold_ms = fired ? (long)(fired - pressed) : -1;
    record("long-hold-fires-and-swallows",
           g_holds == 1 && hold_ms >= THRESHOLD_MS - 20 && hold_ms <= THRESHOLD_MS + 250 &&
               g_sink_down == 0 && g_sink_up == 0,
           "\"holds\": %ld, \"holdMsAfterPress\": %ld, \"thresholdMs\": %d, \"deliveredDowns\": %ld, "
           "\"deliveredUps\": %ld",
           (long)g_holds, hold_ms, THRESHOLD_MS, (long)g_sink_down, (long)g_sink_up);
  }
}

static void scenario_drag(void) {
  int step;
  POINT end = offset(30, 0);
  reset_counts();
  move_to(g_target);
  pump_ms(40);
  middle_down();
  pump_ms(40);
  for (step = 1; step <= 6; step++) {
    move_to(offset(step * 5, 0));
    pump_ms(15);
  }
  middle_up();
  pump_ms(THRESHOLD_MS + 150);
  record("drag-past-slop-passes-through",
         g_holds == 0 && g_sink_down == 1 && g_sink_up == 1 && cursor_near(end, 2),
         "\"holds\": %ld, \"deliveredDowns\": %ld, \"deliveredUps\": %ld, \"cursorEndsWherePointerIs\": %s",
         (long)g_holds, (long)g_sink_down, (long)g_sink_up, cursor_near(end, 2) ? "true" : "false");
}

static void scenario_disarm_mid_press(void) {
  reset_counts();
  move_to(g_target);
  pump_ms(40);
  middle_down();
  pump_ms(100);
  send_command("{\"cmd\":\"disarm\"}\n");
  pump_ms(THRESHOLD_MS + 200);
  middle_up();
  pump_ms(300);
  record("disarm-mid-press-replays-click", g_holds == 0 && g_sink_down == 1 && g_sink_up == 1,
         "\"holds\": %ld, \"deliveredDowns\": %ld, \"deliveredUps\": %ld", (long)g_holds,
         (long)g_sink_down, (long)g_sink_up);
  send_command("{\"cmd\":\"arm\"}\n");
  pump_ms(80);
}

/* Windows silently removes a low-level hook whose thread stops answering. The
 * helper is frozen mid-press while the release arrives; once it runs again it
 * must re-install its hook, give the click back instead of reporting a hold,
 * and catch the next hold normally. */
static void scenario_stall_recovers_hook(void) {
  LONG downs, ups, holds, restored;
  reset_counts();
  move_to(g_target);
  pump_ms(40);
  middle_down();
  pump_ms(100);
  suspend_helper(1);
  pump_ms(50);
  middle_up();
  pump_ms(1600);
  suspend_helper(0);
  pump_ms(1200);
  downs = g_sink_down;
  ups = g_sink_up;
  holds = g_holds;
  restored = g_restored;
  record("stalled-helper-gives-click-back", holds == 0 && downs == 1 && ups >= 1 && restored >= 1,
         "\"holds\": %ld, \"deliveredDowns\": %ld, \"deliveredUps\": %ld, \"recoveries\": %ld",
         (long)holds, (long)downs, (long)ups, (long)restored);

  reset_counts();
  middle_down();
  pump_ms(700);
  middle_up();
  pump_ms(300);
  record("hook-works-again-after-stall", g_holds == 1 && g_sink_down == 0 && g_sink_up == 0,
         "\"holds\": %ld, \"deliveredDowns\": %ld, \"deliveredUps\": %ld", (long)g_holds,
         (long)g_sink_down, (long)g_sink_up);
}

static void scenario_eof_while_pending(const char *helper) {
  DWORD code = 99;
  int exited;
  reset_counts();
  move_to(g_target);
  pump_ms(40);
  middle_down();
  pump_ms(100);
  CloseHandle(g_helper_stdin);
  g_helper_stdin = NULL;
  exited = wait_exit(2000, &code);
  pump_ms(200);
  record("stdin-eof-while-pending-gives-click-back",
         exited && code == 0 && g_sink_down == 1 && g_sink_up == 1 && g_holds == 0,
         "\"helperExited\": %s, \"exitCode\": %lu, \"deliveredDowns\": %ld, \"deliveredUps\": %ld",
         exited ? "true" : "false", (unsigned long)code, (long)g_sink_down, (long)g_sink_up);
  middle_up(); /* the person's real release, now an orphan */
  pump_ms(150);
  CloseHandle(g_helper_process);
  g_helper_process = NULL;

  /* A killed helper loses that one click, but nothing after it. */
  if (!start_helper(helper) || !wait_active(3000)) {
    record("terminate-while-pending-leaves-nothing-swallowed", 0, "\"helperRestarted\": false");
    return;
  }
  configure(1);
  reset_counts();
  middle_down();
  pump_ms(100);
  TerminateProcess(g_helper_process, 9);
  wait_exit(1500, NULL);
  CloseHandle(g_helper_stdin);
  g_helper_stdin = NULL;
  pump_ms(150);
  middle_up();
  pump_ms(60);
  middle_down();
  pump_ms(60);
  middle_up();
  pump_ms(200);
  record("terminate-while-pending-leaves-nothing-swallowed", g_sink_down == 1 && g_sink_up == 2,
         "\"deliveredDownsAfterKill\": %ld, \"deliveredUpsAfterKill\": %ld", (long)g_sink_down,
         (long)g_sink_up);
  CloseHandle(g_helper_process);
  g_helper_process = NULL;
}

static int finish(int status, const char *note) {
  stop_helper();
  if (g_evidence != NULL) {
    fprintf(g_evidence, "\n  ],\n  \"passed\": %s%s%s%s\n}\n", status == 0 ? "true" : "false",
            note ? ",\n  \"note\": \"" : "", note ? note : "", note ? "\"" : "");
    fclose(g_evidence);
  }
  printf("%s\n", status == 0 ? "PEN_MIDDLE_HOLD_WIN_IT_OK" : status == 77 ? "PEN_MIDDLE_HOLD_WIN_IT_SKIPPED"
                                                                          : "PEN_MIDDLE_HOLD_WIN_IT_FAILED");
  fflush(stdout);
  return status;
}

typedef BOOL(WINAPI *set_dpi_context_fn)(HANDLE);

int main(int argc, char **argv) {
  WNDCLASSW window_class;
  POINT cursor_before;
  HMODULE user32;
  FARPROC address;
  if (argc != 3) {
    fprintf(stderr, "usage: hold_it_win <helper.exe> <evidence.json>\n");
    return 64;
  }
  /* Same coordinate space as the helper: physical pixels. */
  user32 = GetModuleHandleW(L"user32.dll");
  address = user32 ? GetProcAddress(user32, "SetProcessDpiAwarenessContext") : NULL;
  if (address != NULL) {
    set_dpi_context_fn set_context;
    memcpy(&set_context, &address, sizeof(set_context));
    set_context((HANDLE)(LONG_PTR)-4);
  }
  g_evidence = fopen(argv[2], "w");
  if (g_evidence != NULL) {
    fprintf(g_evidence,
            "{\n  \"contract\": \"ke.pen.middle-hold.win-integration.v1\",\n  \"thresholdMs\": %d,\n"
            "  \"postedWith\": \"SendInput\",\n  \"observedAt\": \"sink window messages\",\n"
            "  \"positionsRecorded\": false,\n  \"scenarios\": [",
            THRESHOLD_MS);
  }
  GetCursorPos(&cursor_before);

  memset(&window_class, 0, sizeof(window_class));
  window_class.lpfnWndProc = sink_proc;
  window_class.hInstance = GetModuleHandleW(NULL);
  window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
  window_class.hbrBackground = CreateSolidBrush(RGB(255, 58, 42));
  window_class.lpszClassName = L"KEPenHoldTestSink";
  RegisterClassW(&window_class);
  g_sink = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, window_class.lpszClassName,
                           L"KE Pen hold test", WS_POPUP | WS_VISIBLE, 40, 40, SINK_SIZE, SINK_SIZE, NULL, NULL,
                           window_class.hInstance, NULL);
  if (g_sink == NULL) return finish(1, "The sink window could not be created.");
  ShowWindow(g_sink, SW_SHOWNOACTIVATE);
  UpdateWindow(g_sink);
  {
    RECT rect;
    GetWindowRect(g_sink, &rect);
    g_target.x = (rect.left + rect.right) / 2;
    g_target.y = (rect.top + rect.bottom) / 2;
  }
  pump_ms(300);

  if (!start_helper(argv[1])) return finish(1, "The helper could not be started.");
  if (!wait_active(5000)) return finish(1, "The helper never became active.");

  /* Control: disarmed, a middle click reaches the window untouched. If it
   * does not, this session cannot inject input at all. */
  configure(0);
  reset_counts();
  move_to(g_target);
  pump_ms(60);
  middle_down();
  pump_ms(60);
  middle_up();
  pump_ms(300);
  if (g_sink_down != 1 || g_sink_up != 1) {
    record("control-disarmed-click-delivered", 0, "\"deliveredDowns\": %ld, \"deliveredUps\": %ld",
           (long)g_sink_down, (long)g_sink_up);
    SetCursorPos(cursor_before.x, cursor_before.y);
    return finish(77, "This session could not deliver injected input to a window.");
  }
  record("control-disarmed-click-delivered", 1, "\"deliveredDowns\": 1, \"deliveredUps\": 1");

  configure(1);
  scenario_short_click();
  scenario_long_hold();
  scenario_drag();
  scenario_disarm_mid_press();
  scenario_stall_recovers_hook();
  scenario_eof_while_pending(argv[1]);

  SetCursorPos(cursor_before.x, cursor_before.y);
  return finish(g_all_passed ? 0 : 1, NULL);
}
