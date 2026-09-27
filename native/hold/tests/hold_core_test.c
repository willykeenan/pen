#include <string.h>

#include "../hold_core.h"
#include "test_support.h"

#define SLOP 6.0

static hold_machine_t armed_machine(void) {
  hold_machine_t machine;
  hold_init(&machine, SLOP);
  hold_set_armed(&machine, 1);
  return machine;
}

static void test_defaults_start_disarmed(void) {
  hold_machine_t machine;
  hold_init(&machine, SLOP);
  CHECK_EQ(machine.state, HOLD_IDLE);
  CHECK_EQ(machine.armed, 0);
  CHECK_EQ(machine.threshold_ms, 500);
  /* A disarmed helper never swallows anything. */
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_PASSTHROUGH);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DRAG, 40, 40), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 40, 40), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);
}

static void test_short_click_is_replayed_on_release(void) {
  hold_machine_t machine = armed_machine();
  uint32_t down = hold_on_input(&machine, HOLD_INPUT_DOWN, 100, 200);
  CHECK_EQ(down, HOLD_ACT_SWALLOW | HOLD_ACT_STORE_ORIGIN | HOLD_ACT_START_TIMER);
  CHECK_EQ(machine.state, HOLD_PENDING);
  CHECK_EQ(machine.origin_x, 100);
  CHECK_EQ(machine.origin_y, 200);
  {
    uint32_t up = hold_on_input(&machine, HOLD_INPUT_UP, 101, 201);
    CHECK_EQ(up, HOLD_ACT_SWALLOW | HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN |
                     HOLD_ACT_REPLAY_UP);
  }
  CHECK_EQ(machine.state, HOLD_IDLE);
  CHECK_EQ(machine.holds_emitted, 0);
}

static void test_long_hold_emits_once_and_swallows_up(void) {
  hold_machine_t machine = armed_machine();
  uint32_t token;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 5, 5);
  token = machine.token;
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_EMIT_HOLD);
  CHECK_EQ(machine.state, HOLD_FIRED);
  /* A second expiry for the same press is ignored. */
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_NONE);
  CHECK_EQ(machine.holds_emitted, 1);
  /* While fired, drags and the matching up never reach the app. */
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DRAG, 300, 300), HOLD_ACT_SWALLOW);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 300, 300), HOLD_ACT_SWALLOW);
  CHECK_EQ(machine.state, HOLD_IDLE);
}

static void test_stale_timer_token_is_ignored(void) {
  hold_machine_t machine = armed_machine();
  uint32_t first;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 5, 5);
  first = machine.token;
  hold_on_input(&machine, HOLD_INPUT_UP, 5, 5);
  hold_on_input(&machine, HOLD_INPUT_DOWN, 5, 5);
  CHECK(machine.token != first);
  CHECK_EQ(hold_on_timer(&machine, first), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_PENDING);
  CHECK_EQ(hold_on_timer(&machine, machine.token), HOLD_ACT_EMIT_HOLD);
}

static void test_timer_after_release_is_ignored(void) {
  hold_machine_t machine = armed_machine();
  uint32_t token;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 5, 5);
  token = machine.token;
  hold_on_input(&machine, HOLD_INPUT_UP, 5, 5);
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_NONE);
  CHECK_EQ(machine.holds_emitted, 0);
}

static void test_disarm_mid_press_replays_on_up(void) {
  hold_machine_t machine = armed_machine();
  uint32_t token;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 5, 5);
  token = machine.token;
  CHECK_EQ(hold_set_armed(&machine, 0), HOLD_ACT_CANCEL_TIMER);
  CHECK_EQ(machine.state, HOLD_PENDING);
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 5, 5),
           HOLD_ACT_SWALLOW | HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP);
  /* The next press passes straight through while disarmed. */
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DOWN, 5, 5), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 5, 5), HOLD_ACT_NONE);
}

static void test_rearm_mid_press_does_not_restart_timer(void) {
  hold_machine_t machine = armed_machine();
  uint32_t token;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 5, 5);
  token = machine.token;
  hold_set_armed(&machine, 0);
  CHECK_EQ(hold_set_armed(&machine, 1), HOLD_ACT_NONE);
  /* Disarming retired the press's timer token, so even an expiry that was
   * already queued cannot fire it after re-arming. Release replays. */
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_PENDING);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 5, 5) & HOLD_ACT_REPLAY_DOWN,
           HOLD_ACT_REPLAY_DOWN);
}

static void test_small_movement_is_still_a_hold(void) {
  hold_machine_t machine = armed_machine();
  hold_on_input(&machine, HOLD_INPUT_DOWN, 100, 100);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DRAG, 104, 103), HOLD_ACT_SWALLOW);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DRAG, 100, 106), HOLD_ACT_SWALLOW);
  CHECK_EQ(machine.state, HOLD_PENDING);
  CHECK_EQ(hold_on_timer(&machine, machine.token), HOLD_ACT_EMIT_HOLD);
}

static void test_drag_past_slop_hands_press_back(void) {
  hold_machine_t machine = armed_machine();
  uint32_t token;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 100, 100);
  token = machine.token;
  {
    uint32_t drag = hold_on_input(&machine, HOLD_INPUT_DRAG, 100, 107);
    CHECK_EQ(drag, HOLD_ACT_SWALLOW | HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN |
                       HOLD_ACT_REPLAY_CURRENT);
  }
  CHECK_EQ(machine.state, HOLD_PASSTHROUGH);
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DRAG, 100, 140), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 100, 140), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);
  CHECK_EQ(machine.holds_emitted, 0);
}

static void test_orphan_up_passes(void) {
  hold_machine_t machine = armed_machine();
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 1, 1), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DRAG, 1, 1), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);
}

static void test_double_down_replays_the_lost_click_first(void) {
  hold_machine_t machine = armed_machine();
  uint32_t first;
  uint32_t second;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  first = machine.token;
  second = hold_on_input(&machine, HOLD_INPUT_DOWN, 50, 50);
  CHECK_EQ(second, HOLD_ACT_SWALLOW | HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN |
                       HOLD_ACT_REPLAY_UP | HOLD_ACT_STORE_ORIGIN | HOLD_ACT_START_TIMER);
  CHECK(machine.token != first);
  CHECK_EQ(machine.origin_x, 50);

  /* Disarmed between the two downs: the lost click is replayed and the new
   * down is re-posted after it so the app sees them in order. */
  hold_set_armed(&machine, 0);
  second = hold_on_input(&machine, HOLD_INPUT_DOWN, 60, 60);
  CHECK_EQ(second, HOLD_ACT_SWALLOW | HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN |
                       HOLD_ACT_REPLAY_UP | HOLD_ACT_REPLAY_CURRENT);
  CHECK_EQ(machine.state, HOLD_PASSTHROUGH);
}

static void test_down_after_fired_without_up_starts_fresh(void) {
  hold_machine_t machine = armed_machine();
  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  hold_on_timer(&machine, machine.token);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DOWN, 2, 2),
           HOLD_ACT_SWALLOW | HOLD_ACT_STORE_ORIGIN | HOLD_ACT_START_TIMER);
  CHECK_EQ(machine.state, HOLD_PENDING);
}

static void test_tap_reset_and_shutdown_replay_a_pending_click(void) {
  hold_machine_t machine = armed_machine();
  /* The button is already up when the tap comes back: its up went by. */
  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  CHECK_EQ(hold_on_tap_reset(&machine, 0, 0),
           HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP);
  CHECK_EQ(machine.state, HOLD_IDLE);
  CHECK_EQ(machine.armed, 1);
  /* The real up that follows is an orphan and passes. */
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 1, 1), HOLD_ACT_NONE);

  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  CHECK_EQ(hold_on_shutdown(&machine),
           HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP);
  CHECK_EQ(machine.armed, 0);
  CHECK_EQ(machine.state, HOLD_IDLE);

  hold_set_armed(&machine, 1);
  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  hold_on_timer(&machine, machine.token);
  CHECK_EQ(hold_on_tap_reset(&machine, 0, 0), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);
  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  hold_on_timer(&machine, machine.token);
  /* Shutdown never keeps a press: there is nobody left to swallow its up. */
  CHECK_EQ(hold_on_shutdown(&machine), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);
}

/* Reviewer case: a hold has fired and KE Pen has disarmed for its selector
 * when macOS re-enables a timed-out tap. The button is still held, so the
 * matching up must still be swallowed rather than reach the app. */
static void test_fired_press_survives_tap_reset_while_held(void) {
  hold_machine_t machine = armed_machine();
  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  CHECK_EQ(hold_on_timer(&machine, machine.token), HOLD_ACT_EMIT_HOLD);
  hold_set_armed(&machine, 0);
  CHECK_EQ(hold_on_tap_reset(&machine, 1, 0), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_FIRED);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 10, 10), HOLD_ACT_SWALLOW);
  CHECK_EQ(machine.state, HOLD_IDLE);
}

/* A pending press that is still held keeps waiting: the hold must not turn
 * into a click that could open a link or close the menu being captured. */
static void test_pending_press_survives_tap_reset_while_held(void) {
  hold_machine_t machine = armed_machine();
  uint32_t token;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  token = machine.token;
  CHECK_EQ(hold_on_tap_reset(&machine, 1, 0), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_PENDING);
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_EMIT_HOLD);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 10, 10), HOLD_ACT_SWALLOW);

  /* Released before the threshold after the reset: still an ordinary click. */
  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  CHECK_EQ(hold_on_tap_reset(&machine, 1, 0), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 10, 10),
           HOLD_ACT_SWALLOW | HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP);
}

/* A new press began while the tap was off: the app already has its down, so
 * the old press is given back and the new one belongs to the app. */
static void test_new_press_while_unwatched_belongs_to_the_app(void) {
  hold_machine_t machine = armed_machine();
  uint32_t token;
  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  token = machine.token;
  CHECK_EQ(hold_on_tap_reset(&machine, 1, 1),
           HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP);
  CHECK_EQ(machine.state, HOLD_PASSTHROUGH);
  CHECK_EQ(hold_on_timer(&machine, token), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DRAG, 90, 90), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 90, 90), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);

  /* The same from a fired press: nothing to replay, the up passes. */
  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  hold_on_timer(&machine, machine.token);
  CHECK_EQ(hold_on_tap_reset(&machine, 1, 1), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_PASSTHROUGH);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 10, 10), HOLD_ACT_NONE);

  /* And from idle. */
  CHECK_EQ(hold_on_tap_reset(&machine, 1, 1), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_PASSTHROUGH);
  CHECK_EQ(hold_on_tap_reset(&machine, 0, 0), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);
}

/* Reviewer case, mirrored for Windows: a low-level hook the system dropped
 * mid-press is re-installed and the machine is reset with the button up.
 * Every state must come back to idle, so hold to capture works again, and a
 * press still pending is given back as a click. */
static void test_hook_loss_recovery_returns_every_state_to_idle(void) {
  hold_machine_t machine = armed_machine();
  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  CHECK_EQ(hold_on_tap_reset(&machine, 0, 0),
           HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP);
  CHECK_EQ(machine.state, HOLD_IDLE);

  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  hold_on_timer(&machine, machine.token);
  CHECK_EQ(hold_on_tap_reset(&machine, 0, 0), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);

  hold_set_armed(&machine, 0);
  hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10);
  CHECK_EQ(machine.state, HOLD_PASSTHROUGH);
  CHECK_EQ(hold_on_tap_reset(&machine, 0, 0), HOLD_ACT_NONE);
  CHECK_EQ(machine.state, HOLD_IDLE);

  /* And the next press is caught again. */
  hold_set_armed(&machine, 1);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DOWN, 10, 10),
           HOLD_ACT_SWALLOW | HOLD_ACT_STORE_ORIGIN | HOLD_ACT_START_TIMER);
  CHECK_EQ(hold_on_timer(&machine, machine.token), HOLD_ACT_EMIT_HOLD);
}

static void test_threshold_is_clamped(void) {
  hold_machine_t machine;
  hold_init(&machine, SLOP);
  CHECK_EQ(hold_set_threshold(&machine, 0), 200);
  CHECK_EQ(hold_set_threshold(&machine, -40), 200);
  CHECK_EQ(hold_set_threshold(&machine, 199), 200);
  CHECK_EQ(hold_set_threshold(&machine, 200), 200);
  CHECK_EQ(hold_set_threshold(&machine, 750), 750);
  CHECK_EQ(hold_set_threshold(&machine, 1500), 1500);
  CHECK_EQ(hold_set_threshold(&machine, 999999), 1500);
}

static void test_rearm_after_fire(void) {
  hold_machine_t machine = armed_machine();
  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  hold_on_timer(&machine, machine.token);
  /* KE Pen disarms while its selector is open, then re-arms afterwards. */
  CHECK_EQ(hold_set_armed(&machine, 0), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 1, 1), HOLD_ACT_SWALLOW);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1), HOLD_ACT_NONE);
  CHECK_EQ(hold_on_input(&machine, HOLD_INPUT_UP, 1, 1), HOLD_ACT_NONE);
  hold_set_armed(&machine, 1);
  hold_on_input(&machine, HOLD_INPUT_DOWN, 1, 1);
  CHECK_EQ(hold_on_timer(&machine, machine.token), HOLD_ACT_EMIT_HOLD);
  CHECK_EQ(machine.holds_emitted, 2);
}

static void test_state_names(void) {
  CHECK(strcmp(hold_state_name(HOLD_IDLE), "idle") == 0);
  CHECK(strcmp(hold_state_name(HOLD_PENDING), "pending") == 0);
  CHECK(strcmp(hold_state_name(HOLD_FIRED), "fired") == 0);
  CHECK(strcmp(hold_state_name(HOLD_PASSTHROUGH), "passthrough") == 0);
}

/* ---- Property test ------------------------------------------------------ */

static uint32_t rng_state = 0x4b45504eu; /* fixed seed: "KEPN" */

static uint32_t next_random(void) {
  uint32_t x = rng_state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  rng_state = x;
  return x;
}

typedef struct {
  int app_button_down;      /* what the application currently believes */
  int press_outstanding;    /* a swallowed down awaiting its resolution */
  long resolutions;         /* replays or holds for swallowed downs */
  long swallowed_downs;
  long holds;
  long violations;
  int orphan_up_ok;         /* an unwatched period may leave the app unbalanced */
} model_t;

static void violation(model_t *model, const char *what, long step) {
  model->violations++;
  if (model->violations <= 5) fprintf(stderr, "  property violation at step %ld: %s\n", step, what);
}

static void resolve_press(model_t *model, long step) {
  if (!model->press_outstanding) {
    violation(model, "resolved a press that was not outstanding", step);
    return;
  }
  model->press_outstanding = 0;
  model->resolutions++;
}

static void deliver(model_t *model, hold_input_t input, int orphan_allowed, long step) {
  if (input == HOLD_INPUT_DOWN) {
    model->app_button_down = 1;
  } else if (input == HOLD_INPUT_UP) {
    if (!model->app_button_down && !orphan_allowed) {
      violation(model, "delivered an up with no delivered down", step);
    }
    model->app_button_down = 0;
  }
}

/* Performs the actions in the documented platform order. */
static void apply(model_t *model, uint32_t actions, int has_current, hold_input_t current,
                  int orphan_allowed, long step) {
  if ((actions & HOLD_ACT_REPLAY_UP) && !(actions & HOLD_ACT_REPLAY_DOWN)) {
    violation(model, "replayed an up without its down", step);
  }
  if (actions & HOLD_ACT_REPLAY_DOWN) {
    resolve_press(model, step);
    deliver(model, HOLD_INPUT_DOWN, 0, step);
  }
  if (actions & HOLD_ACT_REPLAY_UP) deliver(model, HOLD_INPUT_UP, 0, step);
  if (actions & HOLD_ACT_REPLAY_CURRENT) {
    if (!has_current) violation(model, "re-posted a current event outside a callback", step);
    else deliver(model, current, orphan_allowed, step);
  }
  if (actions & HOLD_ACT_EMIT_HOLD) {
    model->holds++;
    resolve_press(model, step);
  }
  if (has_current && !(actions & HOLD_ACT_SWALLOW)) deliver(model, current, orphan_allowed, step);
  if (has_current && (actions & HOLD_ACT_SWALLOW) && (actions & HOLD_ACT_START_TIMER)) {
    if (current != HOLD_INPUT_DOWN) violation(model, "started a timer for a non-down", step);
    if (model->press_outstanding) violation(model, "swallowed a down over another", step);
    model->press_outstanding = 1;
    model->swallowed_downs++;
  }
  if ((actions & HOLD_ACT_START_TIMER) && !(actions & HOLD_ACT_SWALLOW)) {
    violation(model, "started a timer without swallowing", step);
  }
}

static void test_property_every_swallowed_down_resolves_once(void) {
  hold_machine_t machine;
  model_t model;
  long step;
  uint32_t stale_token = 0;
  memset(&model, 0, sizeof(model));
  hold_init(&machine, SLOP);
  hold_set_armed(&machine, 1);

  for (step = 0; step < 100000; step++) {
    uint32_t roll = next_random() % 100u;
    double x = (double)(next_random() % 40u);
    double y = (double)(next_random() % 40u);
    hold_state_t before = machine.state;
    int armed_before = machine.armed;
    uint32_t actions;

    if (roll < 22) {
      actions = hold_on_input(&machine, HOLD_INPUT_DOWN, x, y);
      apply(&model, actions, 1, HOLD_INPUT_DOWN, 0, step);
    } else if (roll < 44) {
      actions = hold_on_input(&machine, HOLD_INPUT_UP, x, y);
      /* Only an up the machine had no press for may reach the app unbalanced,
       * or one that follows a period nothing was watching. */
      apply(&model, actions, 1, HOLD_INPUT_UP, before == HOLD_IDLE || model.orphan_up_ok, step);
      model.orphan_up_ok = 0;
      if (machine.state != HOLD_IDLE) violation(&model, "an up left the machine busy", step);
    } else if (roll < 64) {
      actions = hold_on_input(&machine, HOLD_INPUT_DRAG, x, y);
      apply(&model, actions, 1, HOLD_INPUT_DRAG, 0, step);
    } else if (roll < 78) {
      uint32_t token = (next_random() % 4u == 0u) ? stale_token : machine.token;
      actions = hold_on_timer(&machine, token);
      if ((actions & HOLD_ACT_EMIT_HOLD) && !armed_before) {
        violation(&model, "emitted a hold while disarmed", step);
      }
      apply(&model, actions, 0, HOLD_INPUT_DOWN, 0, step);
    } else if (roll < 86) {
      actions = hold_set_armed(&machine, (int)(next_random() % 3u != 0u));
      apply(&model, actions, 0, HOLD_INPUT_DOWN, 0, step);
    } else if (roll < 90) {
      /* What reached the app while nothing was watching, then the reset. */
      int button_down = (int)(next_random() % 2u);
      int new_press = button_down && (next_random() % 3u == 0u);
      if (new_press) deliver(&model, HOLD_INPUT_DOWN, 0, step);
      if (!button_down) deliver(&model, HOLD_INPUT_UP, 1, step);
      actions = hold_on_tap_reset(&machine, button_down, new_press);
      /* Replays after an unwatched down may end the app's press early. */
      apply(&model, actions, 0, HOLD_INPUT_DOWN, 0, step);
      if (new_press || !button_down) model.orphan_up_ok = 1;
    } else if (roll < 95) {
      hold_set_threshold(&machine, (long)(next_random() % 3000u));
    } else {
      stale_token = machine.token;
    }
    if (machine.threshold_ms < HOLD_MIN_THRESHOLD_MS || machine.threshold_ms > HOLD_MAX_THRESHOLD_MS) {
      violation(&model, "threshold escaped its clamp", step);
    }
    if (model.press_outstanding != (machine.state == HOLD_PENDING)) {
      violation(&model, "outstanding press disagrees with the machine state", step);
    }
  }
  apply(&model, hold_on_shutdown(&machine), 0, HOLD_INPUT_DOWN, 0, step);

  CHECK_EQ(model.violations, 0);
  CHECK_EQ(model.press_outstanding, 0);
  CHECK_EQ(model.resolutions, model.swallowed_downs);
  CHECK_EQ((long)machine.holds_emitted, model.holds);
  CHECK(model.swallowed_downs > 1000);
  CHECK(model.holds > 100);
  printf("     property: %ld swallowed downs, %ld holds, %ld replays over 100000 steps\n",
         model.swallowed_downs, model.holds, model.resolutions - model.holds);
}

int main(void) {
  RUN(test_defaults_start_disarmed);
  RUN(test_short_click_is_replayed_on_release);
  RUN(test_long_hold_emits_once_and_swallows_up);
  RUN(test_stale_timer_token_is_ignored);
  RUN(test_timer_after_release_is_ignored);
  RUN(test_disarm_mid_press_replays_on_up);
  RUN(test_rearm_mid_press_does_not_restart_timer);
  RUN(test_small_movement_is_still_a_hold);
  RUN(test_drag_past_slop_hands_press_back);
  RUN(test_orphan_up_passes);
  RUN(test_double_down_replays_the_lost_click_first);
  RUN(test_down_after_fired_without_up_starts_fresh);
  RUN(test_tap_reset_and_shutdown_replay_a_pending_click);
  RUN(test_fired_press_survives_tap_reset_while_held);
  RUN(test_pending_press_survives_tap_reset_while_held);
  RUN(test_new_press_while_unwatched_belongs_to_the_app);
  RUN(test_hook_loss_recovery_returns_every_state_to_idle);
  RUN(test_threshold_is_clamped);
  RUN(test_rearm_after_fire);
  RUN(test_state_names);
  RUN(test_property_every_swallowed_down_resolves_once);
  return finish_tests("hold_core");
}
