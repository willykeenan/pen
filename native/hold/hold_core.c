#include "hold_core.h"

void hold_init(hold_machine_t *machine, double slop) {
  machine->state = HOLD_IDLE;
  machine->armed = 0;
  machine->token = 0;
  machine->origin_x = 0;
  machine->origin_y = 0;
  machine->slop = slop > 0 ? slop : 0;
  machine->threshold_ms = HOLD_DEFAULT_THRESHOLD_MS;
  machine->holds_emitted = 0;
}

uint32_t hold_clamp_threshold(long milliseconds) {
  if (milliseconds < (long)HOLD_MIN_THRESHOLD_MS) return HOLD_MIN_THRESHOLD_MS;
  if (milliseconds > (long)HOLD_MAX_THRESHOLD_MS) return HOLD_MAX_THRESHOLD_MS;
  return (uint32_t)milliseconds;
}

uint32_t hold_set_threshold(hold_machine_t *machine, long milliseconds) {
  /* A press already in flight keeps the timer it started with. */
  machine->threshold_ms = hold_clamp_threshold(milliseconds);
  return machine->threshold_ms;
}

/*
 * A replay has to reach the application ahead of the event that caused it.
 * The platform layer can only guarantee that ordering between events it posts
 * itself, so whenever a replay happens and the current event would otherwise
 * pass, the current event is swallowed and re-posted after the replays.
 */
static uint32_t ordered(uint32_t actions) {
  if ((actions & (HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP)) != 0 &&
      (actions & HOLD_ACT_SWALLOW) == 0) {
    actions |= HOLD_ACT_SWALLOW | HOLD_ACT_REPLAY_CURRENT;
  }
  return actions;
}

static uint32_t next_token(hold_machine_t *machine) {
  machine->token += 1u;
  if (machine->token == 0u) machine->token = 1u;
  return machine->token;
}

static uint32_t begin_press(hold_machine_t *machine, double x, double y) {
  if (!machine->armed) {
    /* Disarmed presses belong to the person's app from start to finish. */
    machine->state = HOLD_PASSTHROUGH;
    return HOLD_ACT_NONE;
  }
  machine->state = HOLD_PENDING;
  machine->origin_x = x;
  machine->origin_y = y;
  next_token(machine);
  return HOLD_ACT_SWALLOW | HOLD_ACT_STORE_ORIGIN | HOLD_ACT_START_TIMER;
}

static int moved_past_slop(const hold_machine_t *machine, double x, double y) {
  double dx = x - machine->origin_x;
  double dy = y - machine->origin_y;
  return dx * dx + dy * dy > machine->slop * machine->slop;
}

uint32_t hold_set_armed(hold_machine_t *machine, int armed) {
  machine->armed = armed ? 1 : 0;
  if (!machine->armed && machine->state == HOLD_PENDING) {
    /* The press stays swallowed; its up replays it as an ordinary click. A
     * new token makes any expiry already queued for this press stale. */
    next_token(machine);
    return HOLD_ACT_CANCEL_TIMER;
  }
  return HOLD_ACT_NONE;
}

uint32_t hold_on_input(hold_machine_t *machine, hold_input_t input, double x, double y) {
  uint32_t actions = HOLD_ACT_NONE;
  switch (input) {
    case HOLD_INPUT_DOWN:
      if (machine->state == HOLD_PENDING) {
        /* The previous press lost its up. Give it back as a click first. */
        actions |= HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP;
      }
      machine->state = HOLD_IDLE;
      actions |= begin_press(machine, x, y);
      return ordered(actions);

    case HOLD_INPUT_UP:
      switch (machine->state) {
        case HOLD_PENDING:
          machine->state = HOLD_IDLE;
          return HOLD_ACT_SWALLOW | HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN |
                 HOLD_ACT_REPLAY_UP;
        case HOLD_FIRED:
          machine->state = HOLD_IDLE;
          return HOLD_ACT_SWALLOW;
        case HOLD_PASSTHROUGH:
          machine->state = HOLD_IDLE;
          return HOLD_ACT_NONE;
        case HOLD_IDLE:
        default:
          /* An orphan up never had a down swallowed here, so it is not ours. */
          return HOLD_ACT_NONE;
      }

    case HOLD_INPUT_DRAG:
      switch (machine->state) {
        case HOLD_PENDING:
          if (!moved_past_slop(machine, x, y)) return HOLD_ACT_SWALLOW;
          /* A moving press is a drag (orbit, pan, autoscroll): hand it back. */
          machine->state = HOLD_PASSTHROUGH;
          return ordered(HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN);
        case HOLD_FIRED:
          return HOLD_ACT_SWALLOW;
        case HOLD_PASSTHROUGH:
        case HOLD_IDLE:
        default:
          return HOLD_ACT_NONE;
      }
  }
  return HOLD_ACT_NONE;
}

uint32_t hold_on_timer(hold_machine_t *machine, uint32_t token) {
  if (machine->state != HOLD_PENDING || token != machine->token || !machine->armed) {
    return HOLD_ACT_NONE;
  }
  machine->state = HOLD_FIRED;
  machine->holds_emitted += 1u;
  return HOLD_ACT_EMIT_HOLD;
}

uint32_t hold_on_tap_reset(hold_machine_t *machine, int button_down, int new_press) {
  const int same_press_held = button_down && !new_press;
  switch (machine->state) {
    case HOLD_PENDING:
      /* Still the same press, still held: nothing was missed, so the timer
       * that is already running decides between a click and a hold. */
      if (same_press_held) return HOLD_ACT_NONE;
      /* Otherwise its up went by, or a new press replaced it, while nothing
       * was watching. A full click is the only replay that cannot leave the
       * button stuck down in the app. */
      machine->state = button_down ? HOLD_PASSTHROUGH : HOLD_IDLE;
      return HOLD_ACT_CANCEL_TIMER | HOLD_ACT_REPLAY_DOWN | HOLD_ACT_REPLAY_UP;
    case HOLD_FIRED:
      /* The capture is under way; its matching up must still be swallowed. */
      if (same_press_held) return HOLD_ACT_NONE;
      machine->state = button_down ? HOLD_PASSTHROUGH : HOLD_IDLE;
      return HOLD_ACT_NONE;
    case HOLD_PASSTHROUGH:
      if (!button_down) machine->state = HOLD_IDLE;
      return HOLD_ACT_NONE;
    case HOLD_IDLE:
    default:
      /* A press that began unwatched reached the app; its up belongs there. */
      if (button_down && new_press) machine->state = HOLD_PASSTHROUGH;
      return HOLD_ACT_NONE;
  }
}

uint32_t hold_on_shutdown(hold_machine_t *machine) {
  /* Stopping for good: a click still held back is always given back, and a
   * fired press has nobody left to swallow its up. */
  uint32_t actions = hold_on_tap_reset(machine, 0, 0);
  machine->state = HOLD_IDLE;
  machine->armed = 0;
  return actions;
}

const char *hold_state_name(hold_state_t state) {
  switch (state) {
    case HOLD_IDLE: return "idle";
    case HOLD_PENDING: return "pending";
    case HOLD_FIRED: return "fired";
    case HOLD_PASSTHROUGH: return "passthrough";
  }
  return "unknown";
}
