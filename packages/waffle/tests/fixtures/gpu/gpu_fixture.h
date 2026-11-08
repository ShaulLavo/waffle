#ifndef WAFFLE_GPU_FIXTURE_H
#define WAFFLE_GPU_FIXTURE_H
#include "gpu_encode.h"
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define IMPORT(module, name) __attribute__((import_module(module), import_name(name)))
IMPORT("runtime_window", "surfaces") extern int32_t window_surfaces(void *, uint32_t);
IMPORT("runtime_window", "surface_info") extern int32_t window_surface_info(uint32_t, void *);
IMPORT("runtime_gpu", "open") extern int32_t runtime_gpu_open(uint32_t, void *);
IMPORT("runtime_gpu", "append") extern int32_t runtime_gpu_append(uint32_t, const void *, uint32_t);
IMPORT("runtime_gpu", "completions") extern int32_t runtime_gpu_completions(uint32_t, void *, uint32_t, int64_t, void *);
IMPORT("runtime_gpu", "payload") extern int32_t runtime_gpu_payload(uint32_t, const void *, void *, uint32_t);
IMPORT("runtime_gpu", "close") extern int32_t runtime_gpu_close(uint32_t);

_Static_assert(WAFFLE_GPU_REPLY_ADAPTER_STATUS_OFFSET == WAFFLE_GPU_REPLY_DEVICE_STATUS_OFFSET,
               "request status layout");
_Static_assert(WAFFLE_GPU_REPLY_ADAPTER_ADAPTER_OFFSET == WAFFLE_GPU_REPLY_DEVICE_DEVICE_OFFSET,
               "request handle layout");
_Static_assert(WAFFLE_GPU_REPLY_ADAPTER_MESSAGE_OFFSET == WAFFLE_GPU_REPLY_DEVICE_MESSAGE_OFFSET,
               "request message layout");

static uint32_t connection;
static uint32_t token;
static int frame_credit;
static uint32_t closed_reason;
static uint8_t bytes[8192];
static WaffleGpuWriter writer = {bytes, sizeof(bytes), 0, 0};
static uint32_t expected_texture = TEXTURE;
static uint32_t expected_scope_type = WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR;
static uint32_t format = WAFFLE_GPU_ENUM_TEXTURE_FORMAT_BGRA8_UNORM;

static void close_on_exit(void) {
  if (connection) runtime_gpu_close(connection);
}
static void fail(const char *stage, int32_t status) {
  fprintf(stderr, "GPU_FAIL stage=%s status=%d\n", stage, status);
  exit(1);
}
static void check(const char *stage, int32_t status) {
  if (status != 0) fail(stage, status);
}
static void append(void) {
  if (writer.error || writer.offset == 0) fail("encode", -28);
  check("append", runtime_gpu_append(connection, bytes, (uint32_t)writer.offset));
  writer.offset = 0;
}
static uint32_t next_token(void) {
  return ++token; /* The bounded fixture modes never approach uint32 rollover. */
}
static void expect_handle(const uint8_t *p, uint32_t id) {
  if (gpu_read_u32(p) != id || gpu_read_u32(p + 4) != 1) fail("reply-handle", -28);
}
static void expect_size(uint32_t length, uint32_t minimum) {
  if (length < minimum) fail("reply-size", -28);
}
static void check_message(const uint8_t *p, uint32_t length, uint32_t offset, FILE *output) {
  expect_size(length, offset + 4);
  uint32_t size = gpu_read_u32(p + offset);
  if (size > length - offset - 4) fail("reply-message", -28);
  if (size) fprintf(output, "GPU_MESSAGE %.*s\n", (int)size, (const char *)(p + offset + 4));
}
static void check_request(const uint8_t *p, uint32_t kind, uint32_t length) {
  check_message(p, length, WAFFLE_GPU_REPLY_ADAPTER_MESSAGE_OFFSET, stderr);
  uint32_t status = gpu_read_u32(p + WAFFLE_GPU_REPLY_ADAPTER_STATUS_OFFSET);
  uint32_t success = kind == WAFFLE_GPU_REPLY_ADAPTER
    ? WAFFLE_GPU_ENUM_REQUEST_ADAPTER_STATUS_SUCCESS : WAFFLE_GPU_ENUM_REQUEST_DEVICE_STATUS_SUCCESS;
  if (status != success && kind == WAFFLE_GPU_REPLY_ADAPTER)
    printf("GPU_NO_ADAPTER status=%u\n", status);
  if (status != success) fail("request-result", (int32_t)status);
  expect_handle(p + WAFFLE_GPU_REPLY_ADAPTER_ADAPTER_OFFSET,
                kind == WAFFLE_GPU_REPLY_ADAPTER ? ADAPTER : DEVICE);
}
static void check_result(const uint8_t *p, uint32_t kind, uint32_t length) {
  expect_size(length, 24);
  uint32_t status = gpu_read_u32(p + 16);
  if (kind == WAFFLE_GPU_REPLY_ADAPTER || kind == WAFFLE_GPU_REPLY_DEVICE) {
    check_request(p, kind, length);
    return;
  }
  if (kind == WAFFLE_GPU_REPLY_SURFACE_TEXTURE) {
    expect_size(length, 32);
    expect_handle(p + WAFFLE_GPU_REPLY_SURFACE_TEXTURE_TEXTURE_OFFSET, expected_texture);
    status = gpu_read_u32(p + WAFFLE_GPU_REPLY_SURFACE_TEXTURE_STATUS_OFFSET);
    if (status != WAFFLE_GPU_ENUM_SURFACE_GET_CURRENT_TEXTURE_STATUS_SUCCESS_OPTIMAL &&
        status != WAFFLE_GPU_ENUM_SURFACE_GET_CURRENT_TEXTURE_STATUS_SUCCESS_SUBOPTIMAL)
      fail("surface-texture", (int32_t)status);
    return;
  }
  if (kind == WAFFLE_GPU_REPLY_PRESENT) {
    if (status != WAFFLE_GPU_ENUM_STATUS_SUCCESS) fail("present", (int32_t)status);
    return;
  }
  if (kind != WAFFLE_GPU_REPLY_ERROR_SCOPE) fail("reply-kind", (int32_t)kind);
  check_message(p, length, WAFFLE_GPU_REPLY_ERROR_SCOPE_MESSAGE_OFFSET,
                expected_scope_type == WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR ? stderr : stdout);
  if (status != WAFFLE_GPU_ENUM_POP_ERROR_SCOPE_STATUS_SUCCESS ||
      gpu_read_u32(p + WAFFLE_GPU_REPLY_ERROR_SCOPE_TYPE_OFFSET) != expected_scope_type)
    fail("validation-scope", (int32_t)gpu_read_u32(p + WAFFLE_GPU_REPLY_ERROR_SCOPE_TYPE_OFFSET));
}
static void check_closed(const uint8_t *p, uint32_t length) {
  if (length != 24) fail("closed-size", -28);
  if (gpu_read_u32(p + 8)) fail("closed-token", -28);
  uint32_t reason = gpu_read_u32(p + WAFFLE_GPU_REPLY_CLOSED_REASON_OFFSET);
  if (reason < 1 || reason > 5) fail("closed-reason", -28);
  if (gpu_read_u32(p + 20)) fail("closed-padding", -28);
  closed_reason = reason;
}
static int completion(const uint8_t *p, uint32_t length, uint32_t expected, uint32_t expected_token) {
  if (closed_reason) fail("reply-after-closed", -28);
  uint32_t kind = p[0] | (uint32_t)p[1] << 8;
  if (p[2] || p[3]) fail("reply-flags", -28);
  if (gpu_read_u32(p + 12) != 0) fail("reply-status", (int32_t)gpu_read_u32(p + 12));
  if (kind == WAFFLE_GPU_REPLY_CLOSED) {
    check_closed(p, length);
    return 0;
  }
  if (kind == WAFFLE_GPU_REPLY_FRAME_CREDIT) {
    expect_size(length, 24);
    if (gpu_read_u32(p + 8)) fail("credit-token", -28);
    expect_handle(p + WAFFLE_GPU_REPLY_FRAME_CREDIT_SURFACE_OFFSET, SURFACE);
    frame_credit = 1;
    return 0;
  }
  if (kind != expected || gpu_read_u32(p + 8) != expected_token) {
    fprintf(stderr, "GPU_UNEXPECTED kind=%u token=%u\n", kind, gpu_read_u32(p + 8));
    fail("unexpected-completion", -28);
  }
  check_result(p, kind, length);
  return 1;
}
static int completion_batch(const uint8_t *replies, uint32_t total,
                            uint32_t expected, uint32_t expected_token) {
  uint32_t offset = 0;
  int found = 0;
  while (offset < total) {
    expect_size(total - offset, WAFFLE_GPU_COMPLETION_HEADER_SIZE);
    uint32_t length = gpu_read_u32(replies + offset + 4);
    if (length < WAFFLE_GPU_COMPLETION_HEADER_SIZE || length % 8 || length > total - offset)
      fail("reply-framing", -28);
    found += completion(replies + offset, length, expected, expected_token);
    offset += length;
  }
  if (found > 1) fail("duplicate-completion", -28);
  return found;
}
static int drain(uint32_t expected, uint32_t expected_token, int64_t timeout) {
  uint8_t replies[8192], written[4] = {0};
  for (;;) {
    check("completions", runtime_gpu_completions(connection, replies, sizeof(replies), timeout, written));
    uint32_t total = gpu_read_u32(written);
    if (total > sizeof(replies)) fail("reply-span", -28);
    int found = completion_batch(replies, total, expected, expected_token);
    if (!closed_reason) return found;
    /* Committed closed bytes precede the import's actual terminal errno. */
  }
}
static void wait_for(uint32_t kind, uint32_t reply_token) {
  while (!drain(kind, reply_token, -1)) { }
}
static void scope_barrier(void) {
  gpu_push_scope(&writer);
  uint32_t reply_token = next_token();
  gpu_pop_scope(&writer, reply_token);
  append();
  wait_for(WAFFLE_GPU_REPLY_ERROR_SCOPE, reply_token);
}
static void wait_stdin(const char *stage) {
  printf("GPU_WAIT_STDIN stage=%s\n", stage);
  char byte;
  ssize_t count = read(STDIN_FILENO, &byte, 1);
  if (count < 0) fail("stdin", -1);
  printf("GPU_STDIN stage=%s count=%d\n", stage, (int)count);
}
static void request_device(void) {
  uint32_t reply_token = next_token();
  gpu_adapter(&writer, reply_token);
  append();
  wait_for(WAFFLE_GPU_REPLY_ADAPTER, reply_token);
  puts("GPU_STAGE adapter");
  reply_token = next_token();
  gpu_device(&writer, reply_token);
  append();
  wait_for(WAFFLE_GPU_REPLY_DEVICE, reply_token);
  puts("GPU_STAGE device");
}
static void finish_scope(uint32_t type) {
  uint32_t reply_token = next_token();
  gpu_pop_scope(&writer, reply_token);
  append();
  expected_scope_type = type;
  wait_for(WAFFLE_GPU_REPLY_ERROR_SCOPE, reply_token);
  expected_scope_type = WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR;
}
static void present_frame(unsigned frame, const char *frame_colour) {
  uint32_t reply_token = next_token();
  frame_credit = 0;
  gpu_present(&writer, reply_token);
  append();
  wait_for(WAFFLE_GPU_REPLY_PRESENT, reply_token);
  puts("GPU_STAGE presented");
  while (!frame_credit) drain(0, 0, -1);
  printf("GPU_FRAME colour=%s frame=%u validation=none\n", frame_colour, frame);
}
static uint32_t fixture_open(uint32_t *out_width, uint32_t *out_height) {
  uint8_t surfaces[32] = {0}, info[16] = {0}, opened[4] = {0};
  int32_t count = window_surfaces(surfaces, sizeof(surfaces));
  if (count <= 0 || count > 8) fail("surfaces", count);
  uint32_t surface_id = gpu_read_u32(surfaces);
  check("surface-info", window_surface_info(surface_id, info));
  uint32_t width = gpu_read_u32(info), height = gpu_read_u32(info + 4);
  if (!surface_id || !width || !height) fail("surface-info-values", -28);
  printf("GPU_STAGE surface id=%u width=%u height=%u scale=%u flags=%u\n",
         surface_id, width, height, gpu_read_u32(info + 8), gpu_read_u32(info + 12));
  check("open", runtime_gpu_open(0, opened));
  connection = gpu_read_u32(opened);
  if (!connection) fail("connection", -8);
  if (atexit(close_on_exit)) fail("cleanup", -48);
  puts("GPU_STAGE open");
  request_device();
  *out_width = width;
  *out_height = height;
  return surface_id;
}
static void fixture_close(void) {
  drain(0, 0, 0); /* Observe queued asynchronous failures before ordinary close. */
  uint32_t closed = connection;
  check("close", runtime_gpu_close(closed));
  connection = 0;
  uint8_t handle[8] = {0}, unused;
  int32_t status = runtime_gpu_payload(closed, handle, &unused, 0);
  if (status != -64) fail("closed-payload", status); /* WASI EPIPE */
  check("close-idempotent", runtime_gpu_close(closed));
  puts("GPU_STAGE closed");
}
#endif
