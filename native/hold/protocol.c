#include "protocol.h"

#include <stdio.h>
#include <string.h>

#define TOKEN_MAX 16
#define MAX_MEMBERS 4

typedef struct {
  const char *at;
  const char *end;
} cursor_t;

typedef struct {
  char key[TOKEN_MAX + 1];
  int is_number;
  char text[TOKEN_MAX + 1];
  long number;
} member_t;

static void skip_space(cursor_t *cursor) {
  while (cursor->at < cursor->end &&
         (*cursor->at == ' ' || *cursor->at == '\t' || *cursor->at == '\r')) {
    cursor->at++;
  }
}

static int expect(cursor_t *cursor, char c) {
  skip_space(cursor);
  if (cursor->at >= cursor->end || *cursor->at != c) return 0;
  cursor->at++;
  return 1;
}

/* Strings are plain ASCII words: no escapes, no control bytes, bounded. */
static int read_word(cursor_t *cursor, char *out) {
  size_t used = 0;
  if (!expect(cursor, '"')) return 0;
  while (cursor->at < cursor->end && *cursor->at != '"') {
    char c = *cursor->at;
    int allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                  c == '-' || c == '_';
    if (!allowed || used >= TOKEN_MAX) return 0;
    out[used++] = c;
    cursor->at++;
  }
  if (cursor->at >= cursor->end) return 0;
  cursor->at++;
  out[used] = '\0';
  return used > 0;
}

static int read_number(cursor_t *cursor, long *out) {
  long value = 0;
  int digits = 0;
  skip_space(cursor);
  while (cursor->at < cursor->end && *cursor->at >= '0' && *cursor->at <= '9') {
    if (digits >= 6) return 0;
    value = value * 10 + (*cursor->at - '0');
    digits++;
    cursor->at++;
  }
  if (digits == 0) return 0;
  *out = value;
  return 1;
}

int hold_parse_command(const char *line, size_t length, hold_command_t *out) {
  cursor_t cursor;
  member_t members[MAX_MEMBERS];
  size_t count = 0;
  size_t i, j;
  const char *command = NULL;
  int have_threshold = 0;
  long threshold = 0;

  if (length > HOLD_LINE_MAX) return HOLD_PARSE_TOO_LONG;
  cursor.at = line;
  cursor.end = line + length;
  skip_space(&cursor);
  if (cursor.at >= cursor.end) return HOLD_PARSE_EMPTY;
  if (!expect(&cursor, '{')) return HOLD_PARSE_SYNTAX;

  skip_space(&cursor);
  if (cursor.at < cursor.end && *cursor.at == '}') {
    return HOLD_PARSE_UNKNOWN_COMMAND;
  }
  for (;;) {
    member_t *member;
    if (count >= MAX_MEMBERS) return HOLD_PARSE_SYNTAX;
    member = &members[count];
    memset(member, 0, sizeof(*member));
    if (!read_word(&cursor, member->key)) return HOLD_PARSE_SYNTAX;
    if (!expect(&cursor, ':')) return HOLD_PARSE_SYNTAX;
    skip_space(&cursor);
    if (cursor.at < cursor.end && *cursor.at == '"') {
      if (!read_word(&cursor, member->text)) return HOLD_PARSE_BAD_VALUE;
      member->is_number = 0;
    } else {
      if (!read_number(&cursor, &member->number)) return HOLD_PARSE_BAD_VALUE;
      member->is_number = 1;
    }
    for (j = 0; j < count; j++) {
      if (strcmp(members[j].key, member->key) == 0) return HOLD_PARSE_SYNTAX;
    }
    count++;
    skip_space(&cursor);
    if (cursor.at < cursor.end && *cursor.at == ',') {
      cursor.at++;
      continue;
    }
    if (!expect(&cursor, '}')) return HOLD_PARSE_SYNTAX;
    break;
  }
  skip_space(&cursor);
  if (cursor.at != cursor.end) return HOLD_PARSE_SYNTAX;

  for (i = 0; i < count; i++) {
    const member_t *member = &members[i];
    if (strcmp(member->key, "v") == 0) {
      if (!member->is_number || member->number != HOLD_PROTOCOL_VERSION) {
        return HOLD_PARSE_BAD_VERSION;
      }
    } else if (strcmp(member->key, "cmd") == 0) {
      if (member->is_number) return HOLD_PARSE_BAD_VALUE;
      command = member->text;
    } else if (strcmp(member->key, "thresholdMs") == 0) {
      if (!member->is_number) return HOLD_PARSE_BAD_VALUE;
      have_threshold = 1;
      threshold = member->number;
    } else {
      return HOLD_PARSE_UNKNOWN_KEY;
    }
  }
  if (command == NULL) return HOLD_PARSE_UNKNOWN_COMMAND;

  out->threshold_ms = 0;
  if (strcmp(command, "config") == 0) {
    if (!have_threshold) return HOLD_PARSE_BAD_VALUE;
    out->kind = HOLD_CMD_CONFIG;
    out->threshold_ms = threshold;
    return HOLD_PARSE_OK;
  }
  if (have_threshold) return HOLD_PARSE_UNKNOWN_KEY;
  if (strcmp(command, "arm") == 0) {
    out->kind = HOLD_CMD_ARM;
  } else if (strcmp(command, "disarm") == 0) {
    out->kind = HOLD_CMD_DISARM;
  } else if (strcmp(command, "quit") == 0) {
    out->kind = HOLD_CMD_QUIT;
  } else {
    return HOLD_PARSE_UNKNOWN_COMMAND;
  }
  return HOLD_PARSE_OK;
}

const char *hold_parse_error_code(int result) {
  switch (result) {
    case HOLD_PARSE_OK: return "ok";
    case HOLD_PARSE_TOO_LONG: return "line-too-long";
    case HOLD_PARSE_SYNTAX: return "bad-syntax";
    case HOLD_PARSE_UNKNOWN_COMMAND: return "unknown-command";
    case HOLD_PARSE_UNKNOWN_KEY: return "unknown-key";
    case HOLD_PARSE_BAD_VALUE: return "bad-value";
    case HOLD_PARSE_BAD_VERSION: return "bad-version";
    case HOLD_PARSE_EMPTY: return "empty-line";
    default: return "bad-command";
  }
}

/* Only words from this program ever reach the formatters, but a stray quote
 * or control byte would still break the line, so they are filtered anyway. */
static const char *safe_word(const char *word) {
  const char *p;
  if (word == NULL || *word == '\0' || strlen(word) > 32) return "unknown";
  for (p = word; *p; p++) {
    char c = *p;
    int allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                  c == '-' || c == '_' || c == '.' || c == '+';
    if (!allowed) return "unknown";
  }
  return word;
}

static size_t finish(int written, size_t capacity) {
  if (written <= 0 || (size_t)written >= capacity) return 0;
  return (size_t)written;
}

size_t hold_format_version(char *buffer, size_t capacity, const char *version) {
  return finish(snprintf(buffer, capacity, "{\"name\":\"%s\",\"version\":\"%s\",\"protocol\":%d}\n",
                         HOLD_HELPER_NAME, safe_word(version), HOLD_PROTOCOL_VERSION),
                capacity);
}

size_t hold_format_ready(char *buffer, size_t capacity, const char *version, const char *platform) {
  return finish(snprintf(buffer, capacity,
                         "{\"v\":%d,\"type\":\"ready\",\"name\":\"%s\",\"version\":\"%s\","
                         "\"protocol\":%d,\"platform\":\"%s\"}\n",
                         HOLD_PROTOCOL_VERSION, HOLD_HELPER_NAME, safe_word(version),
                         HOLD_PROTOCOL_VERSION, safe_word(platform)),
                capacity);
}

size_t hold_format_active(char *buffer, size_t capacity) {
  return finish(snprintf(buffer, capacity, "{\"v\":%d,\"type\":\"active\"}\n", HOLD_PROTOCOL_VERSION),
                capacity);
}

size_t hold_format_needs_permission(char *buffer, size_t capacity, const char *permission) {
  return finish(snprintf(buffer, capacity,
                         "{\"v\":%d,\"type\":\"needs-permission\",\"permission\":\"%s\"}\n",
                         HOLD_PROTOCOL_VERSION, safe_word(permission)),
                capacity);
}

size_t hold_format_hold(char *buffer, size_t capacity, uint32_t sequence) {
  return finish(snprintf(buffer, capacity, "{\"v\":%d,\"type\":\"hold\",\"seq\":%lu}\n",
                         HOLD_PROTOCOL_VERSION, (unsigned long)sequence),
                capacity);
}

size_t hold_format_tap_restored(char *buffer, size_t capacity, const char *reason) {
  return finish(snprintf(buffer, capacity, "{\"v\":%d,\"type\":\"tap-restored\",\"reason\":\"%s\"}\n",
                         HOLD_PROTOCOL_VERSION, safe_word(reason)),
                capacity);
}

size_t hold_format_error(char *buffer, size_t capacity, const char *code) {
  return finish(snprintf(buffer, capacity, "{\"v\":%d,\"type\":\"error\",\"code\":\"%s\"}\n",
                         HOLD_PROTOCOL_VERSION, safe_word(code)),
                capacity);
}

void hold_line_reader_init(hold_line_reader_t *reader) {
  reader->length = 0;
  reader->discarding = 0;
  reader->buffer[0] = '\0';
}

void hold_line_reader_feed(hold_line_reader_t *reader, const char *bytes, size_t count,
                           hold_line_callback callback, void *context) {
  size_t i;
  for (i = 0; i < count; i++) {
    char c = bytes[i];
    if (c == '\n') {
      if (reader->discarding) {
        reader->discarding = 0;
      } else {
        reader->buffer[reader->length] = '\0';
        callback(reader->buffer, reader->length, 0, context);
      }
      reader->length = 0;
      continue;
    }
    if (reader->discarding) continue;
    if (reader->length >= HOLD_LINE_MAX) {
      reader->discarding = 1;
      reader->length = 0;
      callback(NULL, 0, 1, context);
      continue;
    }
    reader->buffer[reader->length++] = c;
  }
}
