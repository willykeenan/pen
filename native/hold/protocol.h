/*
 * KE Pen hold helper stdio protocol, version 1.
 *
 * One JSON object per line in each direction, at most HOLD_LINE_MAX bytes.
 * The helper accepts exactly four commands and nothing else:
 *
 *   {"cmd":"config","thresholdMs":500}
 *   {"cmd":"arm"}
 *   {"cmd":"disarm"}
 *   {"cmd":"quit"}
 *
 * An optional "v":1 member is allowed on any command. No command carries a
 * coordinate, a button, a key or an event description, so no process that can
 * write to the helper's stdin can make it post input of its own choosing: the
 * only events the helper ever posts are copies of the person's own swallowed
 * middle click.
 *
 * Messages to KE Pen never carry positions, click counts or timestamps.
 */
#ifndef KE_PEN_HOLD_PROTOCOL_H
#define KE_PEN_HOLD_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define HOLD_PROTOCOL_VERSION 1
#define HOLD_LINE_MAX 1024
#define HOLD_HELPER_NAME "ke-pen-hold-helper"

typedef enum {
  HOLD_CMD_CONFIG = 1,
  HOLD_CMD_ARM = 2,
  HOLD_CMD_DISARM = 3,
  HOLD_CMD_QUIT = 4
} hold_command_kind_t;

typedef struct {
  hold_command_kind_t kind;
  long threshold_ms; /* CONFIG only; clamp with hold_clamp_threshold */
} hold_command_t;

enum {
  HOLD_PARSE_OK = 0,
  HOLD_PARSE_TOO_LONG = -1,
  HOLD_PARSE_SYNTAX = -2,
  HOLD_PARSE_UNKNOWN_COMMAND = -3,
  HOLD_PARSE_UNKNOWN_KEY = -4,
  HOLD_PARSE_BAD_VALUE = -5,
  HOLD_PARSE_BAD_VERSION = -6,
  HOLD_PARSE_EMPTY = -7
};

int hold_parse_command(const char *line, size_t length, hold_command_t *out);
const char *hold_parse_error_code(int result);

/* Each formatter writes a complete line including the trailing newline and
 * returns its length, or 0 when the buffer is too small. */
size_t hold_format_version(char *buffer, size_t capacity, const char *version);
size_t hold_format_ready(char *buffer, size_t capacity, const char *version, const char *platform);
size_t hold_format_active(char *buffer, size_t capacity);
size_t hold_format_needs_permission(char *buffer, size_t capacity, const char *permission);
size_t hold_format_hold(char *buffer, size_t capacity, uint32_t sequence);
size_t hold_format_tap_restored(char *buffer, size_t capacity, const char *reason);
size_t hold_format_error(char *buffer, size_t capacity, const char *code);

/*
 * Incremental line splitter for a byte stream. Complete lines are handed to
 * the callback without their terminator; a line longer than HOLD_LINE_MAX is
 * reported once as too long and discarded up to its newline.
 */
typedef void (*hold_line_callback)(const char *line, size_t length, int too_long, void *context);

typedef struct {
  char buffer[HOLD_LINE_MAX + 1];
  size_t length;
  int discarding;
} hold_line_reader_t;

void hold_line_reader_init(hold_line_reader_t *reader);
void hold_line_reader_feed(hold_line_reader_t *reader, const char *bytes, size_t count,
                           hold_line_callback callback, void *context);

#endif
