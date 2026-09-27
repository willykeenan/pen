#ifndef KE_PEN_HOLD_TEST_SUPPORT_H
#define KE_PEN_HOLD_TEST_SUPPORT_H

#include <stdio.h>
#include <stdlib.h>

static int test_failures = 0;
static int test_checks = 0;

#define CHECK(condition)                                                         \
  do {                                                                           \
    test_checks++;                                                               \
    if (!(condition)) {                                                          \
      test_failures++;                                                           \
      fprintf(stderr, "  FAIL line %d: %s\n", __LINE__, #condition);             \
    }                                                                            \
  } while (0)

#define CHECK_EQ(actual, expected)                                               \
  do {                                                                           \
    long long check_actual = (long long)(actual);                                \
    long long check_expected = (long long)(expected);                            \
    test_checks++;                                                               \
    if (check_actual != check_expected) {                                        \
      test_failures++;                                                           \
      fprintf(stderr, "  FAIL line %d: %s == %lld, expected %lld\n", __LINE__,   \
              #actual, check_actual, check_expected);                            \
    }                                                                            \
  } while (0)

#define RUN(test_function)                                                       \
  do {                                                                           \
    int before = test_failures;                                                  \
    test_function();                                                             \
    printf("%s %s\n", test_failures == before ? "ok  " : "FAIL", #test_function); \
  } while (0)

static int finish_tests(const char *suite) {
  printf("%s: %d checks, %d failures\n", suite, test_checks, test_failures);
  return test_failures == 0 ? 0 : 1;
}

#endif
