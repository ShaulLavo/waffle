#include "gpu_encode.h"
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#ifdef GPU_FIXTURE_VECTORS_ONLY
static void dump(const char *name, WaffleGpuWriter *w) {
  if (w->error) exit(1);
  printf("%s ", name);
  for (size_t i = 0; i < w->offset; ++i) printf("%02x", w->data[i]);
  putchar('\n');
  w->offset = 0;
}
int main(void) {
  uint8_t bytes[4096];
  WaffleGpuWriter w = {bytes, sizeof(bytes), 0, 0};
  gpu_adapter(&w, 1); dump("instance.request_adapter", &w);
  gpu_device(&w, 2); dump("adapter.request_device", &w);
  gpu_acquire(&w, 3, TEXTURE, 2); dump("surface.get_current_texture", &w);
  gpu_queue(&w); dump("device.get_queue", &w);
  gpu_shader(&w, "abc"); dump("device.create_shader_module", &w);
  gpu_surface(&w, 7); dump("instance.create_surface", &w);
  gpu_pipeline(&w, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_BGRA8_UNORM, 0);
  dump("device.create_render_pipeline", &w);
  gpu_present(&w, 4); dump("surface.present", &w);
  gpu_push_scope(&w); dump("device.push_error_scope", &w);
  gpu_draw(&w); dump("render_pass_encoder.draw", &w);
  gpu_configure(&w, 64, 48, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_BGRA8_UNORM);
  dump("configure", &w);
  gpu_pipeline(&w, WAFFLE_GPU_ENUM_TEXTURE_FORMAT_BGRA8_UNORM, 1); dump("pipeline", &w);
  gpu_encode(&w); dump("encode", &w);
  gpu_created(&w, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, VIEW, TEXTURE); dump("view", &w);
  gpu_created(&w, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, ENCODER, DEVICE);
  dump("encoder", &w);
  gpu_submit(&w); dump("submit", &w);
  gpu_pop_scope(&w, 5); dump("scope", &w);
  return 0;
}
#else
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
static uint8_t bytes[8192];
static WaffleGpuWriter writer = {bytes, sizeof(bytes), 0, 0};
static const char *colour = "red";
static int split;
static int pause_acquired;
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
  return ++token; /* This bounded fixture issues fewer than sixteen tokens. */
}
static void expect_handle(const uint8_t *p, uint32_t id) {
  if (gpu_read_u32(p) != id || gpu_read_u32(p + 4) != 1) fail("reply-handle", -28);
}
static void expect_size(uint32_t length, uint32_t minimum) {
  if (length < minimum) fail("reply-size", -28);
}
static void check_message(const uint8_t *p, uint32_t length, uint32_t offset) {
  expect_size(length, offset + 4);
  uint32_t size = gpu_read_u32(p + offset);
  if (size > length - offset - 4) fail("reply-message", -28);
  if (size) fprintf(stderr, "GPU_MESSAGE %.*s\n", (int)size, (const char *)(p + offset + 4));
}
static void check_request(const uint8_t *p, uint32_t kind, uint32_t length) {
  check_message(p, length, WAFFLE_GPU_REPLY_ADAPTER_MESSAGE_OFFSET);
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
    expect_handle(p + WAFFLE_GPU_REPLY_SURFACE_TEXTURE_TEXTURE_OFFSET, TEXTURE);
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
  check_message(p, length, WAFFLE_GPU_REPLY_ERROR_SCOPE_MESSAGE_OFFSET);
  if (status != WAFFLE_GPU_ENUM_POP_ERROR_SCOPE_STATUS_SUCCESS ||
      gpu_read_u32(p + WAFFLE_GPU_REPLY_ERROR_SCOPE_TYPE_OFFSET) != WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR)
    fail("validation-scope", (int32_t)gpu_read_u32(p + WAFFLE_GPU_REPLY_ERROR_SCOPE_TYPE_OFFSET));
}
static int completion(const uint8_t *p, uint32_t length, uint32_t expected, uint32_t expected_token) {
  uint32_t kind = p[0] | (uint32_t)p[1] << 8;
  if (p[2] || p[3]) fail("reply-flags", -28);
  if (gpu_read_u32(p + 12) != 0) fail("reply-status", (int32_t)gpu_read_u32(p + 12));
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
static int drain(uint32_t expected, uint32_t expected_token, int64_t timeout) {
  uint8_t replies[8192], written[4] = {0};
  check("completions", runtime_gpu_completions(connection, replies, sizeof(replies), timeout, written));
  uint32_t total = gpu_read_u32(written);
  if (total > sizeof(replies)) fail("reply-span", -28);
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
static void options(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--split")) { split = 1; continue; }
    if (!strcmp(argv[i], "--pause-acquired")) { pause_acquired = 1; continue; }
    if (!strcmp(argv[i], "--rgba8")) { format = WAFFLE_GPU_ENUM_TEXTURE_FORMAT_RGBA8_UNORM; continue; }
    if (!strcmp(argv[i], "red") || !strcmp(argv[i], "green") || !strcmp(argv[i], "blue")) {
      colour = argv[i];
      continue;
    }
    fail("argument", -28);
  }
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
static void resources(uint32_t surface_id, uint32_t width, uint32_t height) {
  char wgsl[1024];
  const char *rgb = !strcmp(colour, "green") ? "0.0,1.0,0.0" : "1.0,0.0,0.0";
  if (!strcmp(colour, "blue")) rgb = "0.0,0.0,1.0";
  int size = snprintf(wgsl, sizeof(wgsl),
    "@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {"
    "var p=array<vec2f,3>(vec2f(0.0,0.75),vec2f(-0.75,-0.75),vec2f(0.75,-0.75));"
    "return vec4f(p[i],0.0,1.0);}"
    "@fragment fn fs()->@location(0) vec4f{return vec4f(%s,1.0);}", rgb);
  if (size < 0 || (size_t)size >= sizeof(wgsl)) fail("shader-size", -28);
  gpu_push_scope(&writer);
  gpu_surface(&writer, surface_id);
  gpu_configure(&writer, width, height, format);
  gpu_queue(&writer);
  gpu_shader(&writer, wgsl);
  gpu_pipeline(&writer, format, 1);
  uint32_t reply_token = next_token();
  gpu_acquire(&writer, reply_token, TEXTURE, 1);
  append();
  wait_for(WAFFLE_GPU_REPLY_SURFACE_TEXTURE, reply_token);
  printf("GPU_STAGE acquired colour=%s\n", colour);
}
static void render(void) {
  gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, VIEW, TEXTURE);
  gpu_created(&writer, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, ENCODER, DEVICE);
  if (split) { append(); scope_barrier(); puts("GPU_STAGE view-ready"); }
  gpu_encode(&writer);
  if (split) { append(); scope_barrier(); puts("GPU_STAGE encoded"); }
  gpu_submit(&writer);
  uint32_t reply_token = next_token();
  gpu_pop_scope(&writer, reply_token);
  append();
  wait_for(WAFFLE_GPU_REPLY_ERROR_SCOPE, reply_token);
  puts("GPU_STAGE submitted validation=none");
  reply_token = next_token();
  frame_credit = 0;
  gpu_present(&writer, reply_token);
  append();
  wait_for(WAFFLE_GPU_REPLY_PRESENT, reply_token);
  puts("GPU_STAGE presented");
  while (!frame_credit) drain(0, 0, -1);
  printf("GPU_FRAME colour=%s frame=1 validation=none\n", colour);
}
int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  options(argc, argv);
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
  resources(surface_id, width, height);
  if (split) {
    for (int i = 0; i < 3; ++i) {
      scope_barrier();
      printf("GPU_STAGE acquired-barrier index=%d\n", i + 1);
    }
  }
  if (pause_acquired) wait_stdin("acquired");
  render();
  wait_stdin("frame");
  drain(0, 0, 0); /* Observe queued asynchronous failures before ordinary close. */
  uint32_t closed = connection;
  check("close", runtime_gpu_close(closed));
  connection = 0;
  uint8_t handle[8] = {0}, unused;
  int32_t status = runtime_gpu_payload(closed, handle, &unused, 0);
  if (status != -64) fail("closed-payload", status); /* WASI EPIPE */
  check("close-idempotent", runtime_gpu_close(closed));
  puts("GPU_STAGE closed");
  return 0;
}
#endif
