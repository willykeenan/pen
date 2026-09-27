#include <string.h>

#include "../hold_core.h"
#include "../protocol.h"
#include "test_support.h"

static int parse(const char *line, hold_command_t *out) {
  return hold_parse_command(line, strlen(line), out);
}

static void test_accepts_the_four_commands(void) {
  hold_command_t command;
  CHECK_EQ(parse("{\"cmd\":\"arm\"}", &command), HOLD_PARSE_OK);
  CHECK_EQ(command.kind, HOLD_CMD_ARM);
  CHECK_EQ(parse("{\"cmd\":\"disarm\"}", &command), HOLD_PARSE_OK);
  CHECK_EQ(command.kind, HOLD_CMD_DISARM);
  CHECK_EQ(parse("{\"cmd\":\"quit\"}", &command), HOLD_PARSE_OK);
  CHECK_EQ(command.kind, HOLD_CMD_QUIT);
  CHECK_EQ(parse("{\"cmd\":\"config\",\"thresholdMs\":750}", &command), HOLD_PARSE_OK);
  CHECK_EQ(command.kind, HOLD_CMD_CONFIG);
  CHECK_EQ(command.threshold_ms, 750);
  CHECK_EQ(parse("  { \"v\" : 1 , \"cmd\" : \"arm\" }\r", &command), HOLD_PARSE_OK);
  CHECK_EQ(command.kind, HOLD_CMD_ARM);
  CHECK_EQ(parse("{\"thresholdMs\":200,\"cmd\":\"config\",\"v\":1}", &command), HOLD_PARSE_OK);
  CHECK_EQ(command.threshold_ms, 200);
}

static void test_threshold_values_are_bounded_then_clamped(void) {
  hold_command_t command;
  CHECK_EQ(parse("{\"cmd\":\"config\",\"thresholdMs\":999999}", &command), HOLD_PARSE_OK);
  CHECK_EQ(hold_clamp_threshold(command.threshold_ms), 1500);
  CHECK_EQ(parse("{\"cmd\":\"config\",\"thresholdMs\":0}", &command), HOLD_PARSE_OK);
  CHECK_EQ(hold_clamp_threshold(command.threshold_ms), 200);
  CHECK_EQ(parse("{\"cmd\":\"config\",\"thresholdMs\":1000000}", &command), HOLD_PARSE_BAD_VALUE);
  CHECK_EQ(parse("{\"cmd\":\"config\",\"thresholdMs\":-5}", &command), HOLD_PARSE_BAD_VALUE);
  CHECK_EQ(parse("{\"cmd\":\"config\",\"thresholdMs\":5.5}", &command), HOLD_PARSE_SYNTAX);
  CHECK_EQ(parse("{\"cmd\":\"config\",\"thresholdMs\":\"500\"}", &command), HOLD_PARSE_BAD_VALUE);
  CHECK_EQ(parse("{\"cmd\":\"config\"}", &command), HOLD_PARSE_BAD_VALUE);
}

static void test_refuses_anything_that_could_describe_input(void) {
  hold_command_t command;
  /* No coordinate, button, key or event description is ever accepted. */
  CHECK_EQ(parse("{\"cmd\":\"click\",\"x\":10,\"y\":20}", &command), HOLD_PARSE_UNKNOWN_KEY);
  CHECK_EQ(parse("{\"cmd\":\"click\"}", &command), HOLD_PARSE_UNKNOWN_COMMAND);
  CHECK_EQ(parse("{\"cmd\":\"post\"}", &command), HOLD_PARSE_UNKNOWN_COMMAND);
  CHECK_EQ(parse("{\"cmd\":\"replay\"}", &command), HOLD_PARSE_UNKNOWN_COMMAND);
  CHECK_EQ(parse("{\"cmd\":\"arm\",\"x\":1}", &command), HOLD_PARSE_UNKNOWN_KEY);
  CHECK_EQ(parse("{\"cmd\":\"arm\",\"button\":2}", &command), HOLD_PARSE_UNKNOWN_KEY);
  CHECK_EQ(parse("{\"cmd\":\"arm\",\"thresholdMs\":300}", &command), HOLD_PARSE_UNKNOWN_KEY);
  CHECK_EQ(parse("{\"cmd\":\"arm\",\"v\":2}", &command), HOLD_PARSE_BAD_VERSION);
  CHECK_EQ(parse("{\"cmd\":\"arm\",\"v\":\"1\"}", &command), HOLD_PARSE_BAD_VERSION);
}

static void test_refuses_malformed_lines(void) {
  hold_command_t command;
  CHECK_EQ(parse("", &command), HOLD_PARSE_EMPTY);
  CHECK_EQ(parse("   ", &command), HOLD_PARSE_EMPTY);
  CHECK_EQ(parse("arm", &command), HOLD_PARSE_SYNTAX);
  CHECK_EQ(parse("{}", &command), HOLD_PARSE_UNKNOWN_COMMAND);
  CHECK_EQ(parse("{\"cmd\":\"arm\"", &command), HOLD_PARSE_SYNTAX);
  CHECK_EQ(parse("{\"cmd\":\"arm\"} {", &command), HOLD_PARSE_SYNTAX);
  CHECK_EQ(parse("{\"cmd\":\"arm\",}", &command), HOLD_PARSE_SYNTAX);
  CHECK_EQ(parse("{\"cmd\":\"arm\",\"cmd\":\"quit\"}", &command), HOLD_PARSE_SYNTAX);
  CHECK_EQ(parse("{\"cmd\":\"a\\\"rm\"}", &command), HOLD_PARSE_BAD_VALUE);
  CHECK_EQ(parse("{\"cmd\":\"averyveryverylongcommand\"}", &command), HOLD_PARSE_BAD_VALUE);
  CHECK_EQ(parse("{\"cmd\":[\"arm\"]}", &command), HOLD_PARSE_BAD_VALUE);
  CHECK_EQ(parse("{\"a\":1,\"b\":2,\"c\":3,\"d\":4,\"e\":5}", &command), HOLD_PARSE_SYNTAX);
  CHECK_EQ(parse("{\"cmd\":\"arm\"}\n", &command), HOLD_PARSE_SYNTAX);
}

static void test_oversized_lines_are_refused(void) {
  char line[HOLD_LINE_MAX + 2];
  hold_command_t command;
  memset(line, ' ', sizeof(line));
  memcpy(line, "{\"cmd\":\"arm\"}", 13);
  CHECK_EQ(hold_parse_command(line, HOLD_LINE_MAX, &command), HOLD_PARSE_OK);
  CHECK_EQ(hold_parse_command(line, HOLD_LINE_MAX + 1, &command), HOLD_PARSE_TOO_LONG);
  CHECK(strcmp(hold_parse_error_code(HOLD_PARSE_TOO_LONG), "line-too-long") == 0);
  CHECK(strcmp(hold_parse_error_code(HOLD_PARSE_UNKNOWN_KEY), "unknown-key") == 0);
}

typedef struct {
  int lines;
  int too_long;
  char last[64];
} collected_t;

static void collect(const char *line, size_t length, int too_long, void *context) {
  collected_t *collected = (collected_t *)context;
  if (too_long) {
    collected->too_long++;
    return;
  }
  collected->lines++;
  if (length < sizeof(collected->last)) {
    memcpy(collected->last, line, length);
    collected->last[length] = '\0';
  }
}

static void feed_text(hold_line_reader_t *reader, const char *text, collected_t *collected) {
  hold_line_reader_feed(reader, text, strlen(text), collect, collected);
}

static void test_line_reader_splits_and_discards(void) {
  hold_line_reader_t reader;
  collected_t collected;
  static char huge[HOLD_LINE_MAX * 3];
  memset(&collected, 0, sizeof(collected));
  hold_line_reader_init(&reader);
  feed_text(&reader, "{\"cmd\":", &collected);
  CHECK_EQ(collected.lines, 0);
  feed_text(&reader, "\"arm\"}\n{\"cmd\":\"quit\"}\n", &collected);
  CHECK_EQ(collected.lines, 2);
  CHECK(strcmp(collected.last, "{\"cmd\":\"quit\"}") == 0);

  memset(huge, 'x', sizeof(huge));
  hold_line_reader_feed(&reader, huge, sizeof(huge), collect, &collected);
  CHECK_EQ(collected.too_long, 1);
  feed_text(&reader, "tail-of-the-long-line\n{\"cmd\":\"arm\"}\n", &collected);
  CHECK_EQ(collected.lines, 3);
  CHECK(strcmp(collected.last, "{\"cmd\":\"arm\"}") == 0);
  CHECK_EQ(collected.too_long, 1);
}

static void test_messages_carry_no_positions(void) {
  char buffer[256];
  size_t length;
  length = hold_format_ready(buffer, sizeof(buffer), "0.6.0", "darwin");
  CHECK(length > 0 && buffer[length - 1] == '\n');
  CHECK(strcmp(buffer,
               "{\"v\":1,\"type\":\"ready\",\"name\":\"ke-pen-hold-helper\",\"version\":\"0.6.0\","
               "\"protocol\":1,\"platform\":\"darwin\"}\n") == 0);
  length = hold_format_hold(buffer, sizeof(buffer), 7);
  CHECK(strcmp(buffer, "{\"v\":1,\"type\":\"hold\",\"seq\":7}\n") == 0);
  CHECK(strstr(buffer, "\"x\"") == NULL && strstr(buffer, "\"y\"") == NULL);
  length = hold_format_active(buffer, sizeof(buffer));
  CHECK(strcmp(buffer, "{\"v\":1,\"type\":\"active\"}\n") == 0);
  length = hold_format_needs_permission(buffer, sizeof(buffer), "accessibility");
  CHECK(strcmp(buffer,
               "{\"v\":1,\"type\":\"needs-permission\",\"permission\":\"accessibility\"}\n") == 0);
  length = hold_format_tap_restored(buffer, sizeof(buffer), "timeout");
  CHECK(strcmp(buffer, "{\"v\":1,\"type\":\"tap-restored\",\"reason\":\"timeout\"}\n") == 0);
  length = hold_format_error(buffer, sizeof(buffer), "bad\"code");
  CHECK(strcmp(buffer, "{\"v\":1,\"type\":\"error\",\"code\":\"unknown\"}\n") == 0);
  length = hold_format_version(buffer, sizeof(buffer), "0.6.0");
  CHECK(strcmp(buffer, "{\"name\":\"ke-pen-hold-helper\",\"version\":\"0.6.0\",\"protocol\":1}\n") ==
        0);
  CHECK_EQ(hold_format_ready(buffer, 8, "0.6.0", "darwin"), 0);
  (void)length;
}

int main(void) {
  RUN(test_accepts_the_four_commands);
  RUN(test_threshold_values_are_bounded_then_clamped);
  RUN(test_refuses_anything_that_could_describe_input);
  RUN(test_refuses_malformed_lines);
  RUN(test_oversized_lines_are_refused);
  RUN(test_line_reader_splits_and_discards);
  RUN(test_messages_carry_no_positions);
  return finish_tests("protocol");
}
