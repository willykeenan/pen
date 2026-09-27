/*
 * KE Pen hold-to-capture state machine.
 *
 * Pure C99 with no operating-system headers, so the macOS event tap, the
 * Windows low-level mouse hook and the unit tests all drive the exact same
 * transitions. The platform layer feeds middle-button input, timer expiries
 * and arm/disarm requests in, and performs the returned action bits in this
 * order: CANCEL_TIMER, REPLAY_DOWN, REPLAY_UP, REPLAY_CURRENT, STORE_ORIGIN,
 * START_TIMER, EMIT_HOLD. SWALLOW decides whether the event being processed
 * is dropped (set) or passed through untouched (clear).
 *
 * Only the middle button ever reaches this machine. Coordinates are kept for
 * one press so a drag can be told apart from a still hold; they are never
 * reported anywhere.
 */
#ifndef KE_PEN_HOLD_CORE_H
#define KE_PEN_HOLD_CORE_H

#include <stdint.h>

#define HOLD_MIN_THRESHOLD_MS 200u
#define HOLD_MAX_THRESHOLD_MS 1500u
#define HOLD_DEFAULT_THRESHOLD_MS 500u

typedef enum {
  HOLD_IDLE = 0,
  HOLD_PENDING = 1,     /* down swallowed, waiting for the threshold */
  HOLD_FIRED = 2,       /* threshold passed, capture requested */
  HOLD_PASSTHROUGH = 3  /* this press belongs to the person's app */
} hold_state_t;

typedef enum {
  HOLD_INPUT_DOWN = 0,
  HOLD_INPUT_UP = 1,
  HOLD_INPUT_DRAG = 2
} hold_input_t;

enum {
  HOLD_ACT_NONE = 0u,
  HOLD_ACT_SWALLOW = 1u << 0,        /* drop the event being processed */
  HOLD_ACT_START_TIMER = 1u << 1,    /* arm the threshold timer with `token` */
  HOLD_ACT_CANCEL_TIMER = 1u << 2,   /* stop the threshold timer */
  HOLD_ACT_REPLAY_DOWN = 1u << 3,    /* re-post the stored down */
  HOLD_ACT_REPLAY_UP = 1u << 4,      /* post an up at the stored down's location */
  HOLD_ACT_EMIT_HOLD = 1u << 5,      /* tell KE Pen to freeze and select */
  HOLD_ACT_STORE_ORIGIN = 1u << 6,   /* keep a copy of the current down */
  HOLD_ACT_REPLAY_CURRENT = 1u << 7  /* re-post the current event after replays */
};

typedef struct {
  hold_state_t state;
  int armed;              /* only KE Pen's main process arms the machine */
  uint32_t token;         /* identifies the press the running timer belongs to */
  double origin_x;
  double origin_y;
  double slop;            /* movement that turns a press into a drag */
  uint32_t threshold_ms;
  uint32_t holds_emitted;
} hold_machine_t;

void hold_init(hold_machine_t *machine, double slop);
uint32_t hold_clamp_threshold(long milliseconds);
uint32_t hold_set_threshold(hold_machine_t *machine, long milliseconds);
uint32_t hold_set_armed(hold_machine_t *machine, int armed);
uint32_t hold_on_input(hold_machine_t *machine, hold_input_t input, double x, double y);
uint32_t hold_on_timer(hold_machine_t *machine, uint32_t token);
uint32_t hold_on_tap_reset(hold_machine_t *machine);
uint32_t hold_on_shutdown(hold_machine_t *machine);
const char *hold_state_name(hold_state_t state);

#endif
