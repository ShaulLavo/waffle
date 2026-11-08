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
  gpu_release(&w, WAFFLE_GPU_OBJECT_TEXTURE, 32); dump("release", &w);
  return 0;
}
#else
#include "gpu_fixture.h"
static const char *colour = "red";
static int split;
static int pause_acquired;
static int repeat_acquire;
static int discard_after_first;
static int expired_frame_use;
static int grant_quota;
static int payload_pressure;
enum { FAIRNESS_NONE, FAIRNESS_HEAVY, FAIRNESS_PEER, FAIRNESS_SEEDED };
static int fairness;
static uint32_t fairness_seed;
#define FAIRNESS_DRAWS 200000u
static uint32_t fairness_draws = FAIRNESS_DRAWS;
#define FAIRNESS_FRAMES 3u

static uint32_t parse_seed(const char *text) {
  char *end;
  unsigned long value = strtoul(text, &end, 10);
  if (!*text || *end || value > 65535) fail("fairness-seed", -28);
  return (uint32_t)value;
}

static void options(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--fairness-heavy")) { fairness = FAIRNESS_HEAVY; continue; }
    if (!strcmp(argv[i], "--desktop-heavy-20k")) { fairness = FAIRNESS_HEAVY; fairness_draws = 20000u; continue; }
    if (!strcmp(argv[i], "--desktop-heavy-50k")) { fairness = FAIRNESS_HEAVY; fairness_draws = 50000u; continue; }
    if (!strcmp(argv[i], "--fairness-peer")) { fairness = FAIRNESS_PEER; continue; }
    if (!strcmp(argv[i], "--fairness-seed") && i + 1 < argc) {
      fairness = FAIRNESS_SEEDED;
      fairness_seed = parse_seed(argv[++i]);
      continue;
    }
    if (!strcmp(argv[i], "--grant-quota")) { grant_quota = 1; continue; }
    if (!strcmp(argv[i], "--payload-pressure")) { payload_pressure = 1; continue; }
    if (!strcmp(argv[i], "--repeat-acquire")) { repeat_acquire = 1; continue; }
    if (!strcmp(argv[i], "--discard-after-first-frame")) { discard_after_first = 1; continue; }
    if (!strcmp(argv[i], "--expired-frame-use")) { expired_frame_use = 1; continue; }
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
  gpu_configure_alpha(&writer, width, height, format, discard_after_first
    ? WAFFLE_GPU_ENUM_COMPOSITE_ALPHA_MODE_PREMULTIPLIED : WAFFLE_GPU_ENUM_COMPOSITE_ALPHA_MODE_OPAQUE);
  gpu_queue(&writer);
  gpu_shader(&writer, wgsl);
  gpu_pipeline(&writer, format, 1);
  uint32_t reply_token = next_token();
  gpu_acquire(&writer, reply_token, TEXTURE, 1);
  append();
  wait_for(WAFFLE_GPU_REPLY_SURFACE_TEXTURE, reply_token);
  printf("GPU_STAGE acquired colour=%s\n", colour);
}
static void acquire_frame(uint32_t texture) {
  expected_texture = texture;
  uint32_t reply_token = next_token();
  gpu_acquire(&writer, reply_token, texture, 1);
  append();
  wait_for(WAFFLE_GPU_REPLY_SURFACE_TEXTURE, reply_token);
}
static void encode_frame(const GpuFixtureFrame *frame, uint32_t load, const double clear[4], int draw) {
  gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, frame->view, frame->texture);
  gpu_created(&writer, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, frame->encoder, DEVICE);
  if (split) { append(); scope_barrier(); puts("GPU_STAGE view-ready"); }
  gpu_encode_frame(&writer, frame, load, clear, draw);
  if (split) { append(); scope_barrier(); puts("GPU_STAGE encoded"); }
  gpu_submit_frame(&writer, frame);
}
static GpuFixtureFrame render(void) {
  GpuFixtureFrame frame = gpu_frame(TEXTURE);
  const double black[4] = {0, 0, 0, 1}, green[4] = {0, 1, 0, 1};
  if (repeat_acquire) {
    encode_frame(&frame, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR, green, 0);
    append();
    scope_barrier();
    puts("GPU_STAGE repeat-first-submitted");
    acquire_frame(13);
    frame = gpu_frame(13);
    puts("GPU_REPEATED_ACQUIRE first=8 second=13");
  }
  encode_frame(&frame, repeat_acquire ? WAFFLE_GPU_ENUM_LOAD_OP_LOAD : WAFFLE_GPU_ENUM_LOAD_OP_CLEAR,
               black, 1);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  puts("GPU_STAGE submitted validation=none");
  present_frame(1, colour);
  return frame;
}
static void release_frame_objects(const GpuFixtureFrame *frame) {
  gpu_release(&writer, WAFFLE_GPU_OBJECT_TEXTURE_VIEW, frame->view);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_COMMAND_ENCODER, frame->encoder);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_RENDER_PASS_ENCODER, frame->pass);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_COMMAND_BUFFER, frame->commands);
}
static GpuFixtureFrame discard_frame(void) {
  GpuFixtureFrame frame = gpu_frame(32);
  const double green[4] = {0, 1, 0, 1}, transparent[4] = {0, 0, 0, 0};
  gpu_push_scope(&writer);
  acquire_frame(frame.texture);
  acquire_frame(37); /* A second handle must not keep this discarded frame alive. */
  encode_frame(&frame, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR, green, 0);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  release_frame_objects(&frame);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_TEXTURE, frame.texture);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_TEXTURE, 37);
  append();
  scope_barrier();
  puts("GPU_DISCARDED frame=2 handles=32,37 validation=none");
  wait_stdin("discarded");
  frame = gpu_frame(40);
  gpu_push_scope(&writer);
  acquire_frame(frame.texture);
  encode_frame(&frame, WAFFLE_GPU_ENUM_LOAD_OP_LOAD, transparent, 0);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  present_frame(3, "transparent");
  return frame;
}
static void expired_use(const GpuFixtureFrame *presented) {
  GpuFixtureFrame late = gpu_frame(48);
  late.texture = presented->texture; /* Still a live handle to the destroyed native texture. */
  const double ignored[4] = {0, 0, 0, 0};
  gpu_push_scope(&writer);
  encode_frame(&late, WAFFLE_GPU_ENUM_LOAD_OP_LOAD, ignored, 1);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_VALIDATION);
  printf("GPU_EXPECTED_VALIDATION stage=expired-frame texture=%u type=%u\n",
         late.texture, (unsigned)WAFFLE_GPU_ENUM_ERROR_TYPE_VALIDATION);
  release_frame_objects(&late);
  scope_barrier();
  puts("GPU_STAGE after-expired-validation connection=ready");
}

static void fairness_retire(const GpuFixtureFrame *frame) {
  release_frame_objects(frame);
  gpu_release(&writer, WAFFLE_GPU_OBJECT_TEXTURE, frame->texture);
  append();
  scope_barrier();
}
static void fairness_large_blob(const GpuFixtureFrame *frame) {
  const size_t capacity = (size_t)fairness_draws * 24 + 512;
  uint8_t *blob = malloc(capacity);
  if (!blob) fail("fairness-allocation", -48);
  WaffleGpuWriter large = {blob, capacity, 0, 0};
  size_t start = waffle_gpu_begin(&large, WAFFLE_GPU_OP_ENCODE);
  gpu_object(&large, frame->encoder);
  waffle_gpu_u32(&large, 0);
  WaffleGpuWriter nested = {blob + large.offset, capacity - large.offset, 0, 0};
  const double clear[4] = {0, 0, 0, 1};
  gpu_render_begin(&nested, frame, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR, clear);
  size_t pipeline = waffle_gpu_begin(&nested, WAFFLE_GPU_OP_RENDER_PASS_ENCODER_SET_PIPELINE);
  gpu_object(&nested, PIPELINE);
  waffle_gpu_end(&nested, pipeline);
  for (uint32_t draw = 0; draw < fairness_draws; ++draw) gpu_draw(&nested);
  gpu_render_end(&nested, frame);
  uint32_t length = (uint32_t)nested.offset;
  for (unsigned byte = 0; byte < 4; ++byte) blob[16 + byte] = (uint8_t)(length >> (byte * 8));
  large.offset += nested.offset;
  waffle_gpu_end(&large, start);
  if (nested.error || large.error || (fairness_draws == FAIRNESS_DRAWS && large.offset <= 4 * 1024 * 1024)) fail("fairness-blob-size", -28);
  printf("GPU_FAIRNESS_BLOB draws=%u bytes=%u appends=1\n", fairness_draws, (unsigned)large.offset);
  check("fairness-append", runtime_gpu_append(connection, blob, (uint32_t)large.offset));
  free(blob);
  puts("GPU_FAIRNESS_PUBLISHED");
}
static void fairness_heavy(void) {
  GpuFixtureFrame frame = gpu_frame(TEXTURE);
  gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, frame.view, frame.texture);
  gpu_created(&writer, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, frame.encoder, DEVICE);
  append();
  scope_barrier();
  wait_stdin("fairness-heavy-ready");
  fairness_large_blob(&frame);
  scope_barrier();
  printf("GPU_FAIRNESS_REPLAYED draws=%u\n", fairness_draws);
  gpu_submit_frame(&writer, &frame);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  present_frame(1, colour);
  wait_stdin("frame");
}
static int fairness_peer_input(unsigned frame) {
  printf("GPU_WAIT_STDIN stage=fairness-peer frame=%u\n", frame);
  char byte = 0;
  ssize_t count = read(STDIN_FILENO, &byte, 1);
  if (count != 1) fail("fairness-peer-stdin", -28);
  return byte != 'q';
}
static void fairness_peer(void) {
  for (unsigned index = 0; index < 256; ++index) {
    GpuFixtureFrame frame = gpu_frame(index ? 64 + index * 8 : TEXTURE);
    if (index) { gpu_push_scope(&writer); acquire_frame(frame.texture); }
    const double clear[4] = {0, 0, 0, 1};
    encode_frame(&frame, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR, clear, 1);
    finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
    present_frame(index + 1, colour);
    fairness_retire(&frame);
    if (!fairness_peer_input(index + 1)) return;
  }
  fail("fairness-peer-bound", -48);
}
static void fairness_checkpoint(unsigned frame, const char *stage) {
  printf("GPU_FAIRNESS_CHECKPOINT seed=%u frame=%u stage=%s\n", fairness_seed, frame, stage);
  wait_stdin(stage);
}
static void fairness_seeded(void) {
  for (unsigned index = 0; index < FAIRNESS_FRAMES; ++index) {
    GpuFixtureFrame frame = gpu_frame(index ? 64 + index * 8 : TEXTURE);
    if (index) { gpu_push_scope(&writer); acquire_frame(frame.texture); }
    fairness_checkpoint(index + 1, "seed-acquired");
    gpu_created(&writer, WAFFLE_GPU_OP_TEXTURE_CREATE_VIEW, frame.view, frame.texture);
    gpu_created(&writer, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, frame.encoder, DEVICE);
    append();
    scope_barrier();
    fairness_checkpoint(index + 1, "seed-view");
    double clear[4] = {(double)((fairness_seed + index * 17) % 64) / 255.0,
      (double)((fairness_seed * 3 + index * 11) % 64) / 255.0,
      (double)((fairness_seed * 7 + index * 5) % 64) / 255.0, 1};
    gpu_encode_frame(&writer, &frame, WAFFLE_GPU_ENUM_LOAD_OP_CLEAR, clear, 1);
    append();
    scope_barrier();
    fairness_checkpoint(index + 1, "seed-encoded");
    gpu_submit_frame(&writer, &frame);
    finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
    fairness_checkpoint(index + 1, "seed-submitted");
    present_frame(index + 1, colour);
    fairness_retire(&frame);
    fairness_checkpoint(index + 1, "seed-presented");
  }
}

static void quota_reopen(void) {
  uint8_t surfaces[32] = {0}, info[16] = {0};
  int32_t count = window_surfaces(surfaces, sizeof(surfaces));
  if (count != 1) fail("quota-surfaces", count);
  uint32_t surface = gpu_read_u32(surfaces);
  check("quota-surface-info", window_surface_info(surface, info));
  printf("GPU_STAGE surface id=%u width=%u height=%u\n",
         surface, gpu_read_u32(info), gpu_read_u32(info + 4));
  unsigned refusals = 0;
  for (unsigned cycle = 1; cycle <= 16; ++cycle) {
    uint32_t opened = 0xdeadbeef;
    int32_t status = runtime_gpu_open(0, &opened);
    printf("GPU_QUOTA_OPEN cycle=%u status=%d output=%u\n", cycle, status, opened);
    if (status != 0) {
      if (status != -48 || opened != 0xdeadbeef) fail("quota-refusal", status);
      printf("GPU_QUOTA_REFUSED index=%u\n", ++refusals);
      wait_stdin("quota-refused");
      if (refusals == 2) return;
      continue;
    }
    if (refusals || !opened || opened != cycle) fail("quota-connection", -28);
    connection = opened;
    request_device();
    resources(surface, gpu_read_u32(info), gpu_read_u32(info + 4));
    render();
    wait_stdin("quota-open");
    fixture_close();
    printf("GPU_QUOTA_CLOSED cycle=%u\n", cycle);
    wait_stdin("quota-close");
  }
  fail("quota-bound", -48);
}

/* Header, success status, empty message, payload handle, length and padding. */
#define PAYLOAD_RECORD_BYTES 40u
#define PAYLOAD_CLOSED_BYTES 24u
#define PAYLOAD_RESOURCE_REASON 3u /* GPU_TERMINAL.resource */
#define PAYLOAD_RESOURCE_ERRNO (-48)
static const char payload_wgsl[] = "@compute @workgroup_size(1) fn main() {}";
typedef struct PayloadResult { uint32_t token, id, generation, length; } PayloadResult;
typedef struct PayloadDrain { unsigned records, successes, closed; uint32_t reason; PayloadResult last; } PayloadDrain;
static uint64_t payload_seen;

static void payload_request(unsigned index, uint32_t reply_token) {
  size_t start = waffle_gpu_begin(&writer, WAFFLE_GPU_OP_SHADER_MODULE_GET_COMPILATION_INFO);
  waffle_gpu_token(&writer, reply_token);
  gpu_object(&writer, SHADER);
  waffle_gpu_end(&writer, start);
  append();
  printf("GPU_PAYLOAD_REQUESTED index=%u token=%u\n", index, reply_token);
}
static PayloadResult payload_success(const uint8_t *p, uint32_t length, uint32_t expected_token) {
  uint32_t kind = p[0] | (uint32_t)p[1] << 8;
  if (kind != WAFFLE_GPU_REPLY_COMPILATION_RESULT || p[2] || p[3] || gpu_read_u32(p + 8) != expected_token) {
    fprintf(stderr, "GPU_UNEXPECTED kind=%u token=%u\n", kind, gpu_read_u32(p + 8));
    fail("payload-correlation", -28);
  }
  if (gpu_read_u32(p + 12)) fail("payload-bridge-status", (int32_t)gpu_read_u32(p + 12));
  uint32_t status = gpu_read_u32(p + WAFFLE_GPU_REPLY_COMPILATION_RESULT_STATUS_OFFSET);
  if (status != WAFFLE_GPU_ENUM_COMPILATION_INFO_REQUEST_STATUS_SUCCESS) fail("payload-status", (int32_t)status);
  if (length != PAYLOAD_RECORD_BYTES || gpu_read_u32(p + WAFFLE_GPU_REPLY_COMPILATION_RESULT_MESSAGE_OFFSET) ||
      gpu_read_u32(p + 36))
    fail("payload-record", (int32_t)length);
  PayloadResult result = {expected_token, gpu_read_u32(p + 24), gpu_read_u32(p + 28), gpu_read_u32(p + 32)};
  if (!result.id || result.id > WAFFLE_GPU_PAYLOAD_SLOTS || !result.generation ||
      result.length > WAFFLE_GPU_PAYLOAD_DATABYTES || payload_seen & (UINT64_C(1) << (result.id - 1)))
    fail("payload-handle", -28);
  payload_seen |= UINT64_C(1) << (result.id - 1);
  return result;
}
static void payload_print(unsigned index, PayloadResult result, const char *phase) {
  printf("GPU_PAYLOAD_RESULT index=%u token=%u handle=%u generation=%u length=%u read=0 phase=%s\n",
         index, result.token, result.id, result.generation, result.length, phase);
}
/* Early replies are drained one at a time; their payload handles are deliberately never read. */
static void payload_wait(unsigned index, uint32_t reply_token) {
  uint8_t replies[256], written[4] = {0};
  check("payload-completions",
        runtime_gpu_completions(connection, replies, sizeof(replies), -1, written));
  uint32_t total = gpu_read_u32(written);
  if (total != PAYLOAD_RECORD_BYTES) fail("payload-batch", (int32_t)total);
  payload_print(index, payload_success(replies, gpu_read_u32(replies + 4), reply_token), "ready");
}
static void payload_terminal_record(const uint8_t *p, uint32_t length, uint32_t last_token,
                                    PayloadDrain *drained) {
  uint32_t kind = p[0] | (uint32_t)p[1] << 8;
  drained->records++;
  if (drained->closed) fail("payload-after-closed", -28);
  if (kind != WAFFLE_GPU_REPLY_CLOSED) {
    if (drained->successes) fail("payload-extra-result", -28);
    drained->last = payload_success(p, length, last_token);
    drained->successes++;
    payload_print(WAFFLE_GPU_PAYLOAD_SLOTS, drained->last, "terminal");
    return;
  }
  if (length != PAYLOAD_CLOSED_BYTES || p[2] || p[3] || gpu_read_u32(p + 8) || gpu_read_u32(p + 12))
    fail("payload-closed-record", -28);
  drained->reason = gpu_read_u32(p + WAFFLE_GPU_REPLY_CLOSED_REASON_OFFSET);
  drained->closed++;
}
static int32_t payload_terminal_batch(uint32_t last_token, PayloadDrain *drained) {
  uint8_t replies[256], written[4] = {0};
  int32_t status = runtime_gpu_completions(connection, replies, sizeof(replies), -1, written);
  if (status) return status;
  uint32_t total = gpu_read_u32(written), offset = 0;
  if (!total || total > sizeof(replies)) fail("payload-terminal-span", (int32_t)total);
  while (offset < total) {
    expect_size(total - offset, WAFFLE_GPU_COMPLETION_HEADER_SIZE);
    uint32_t length = gpu_read_u32(replies + offset + 4);
    if (length < WAFFLE_GPU_COMPLETION_HEADER_SIZE || length % 8 || length > total - offset)
      fail("payload-terminal-framing", -28);
    payload_terminal_record(replies + offset, length, last_token, drained);
    offset += length;
  }
  return 0;
}
static void payload_after_terminal(const PayloadDrain *drained) {
  uint8_t handle[8], destination[64];
  for (unsigned byte = 0; byte < 4; ++byte) {
    handle[byte] = (uint8_t)(drained->last.id >> (byte * 8));
    handle[4 + byte] = (uint8_t)(drained->last.generation >> (byte * 8));
  }
  int32_t status = runtime_gpu_payload(connection, handle, destination, sizeof(destination));
  printf("GPU_PAYLOAD_AFTER_TERMINAL token=%u handle=%u generation=%u read=%d\n",
         drained->last.token, drained->last.id, drained->last.generation, status);
  if (status != PAYLOAD_RESOURCE_ERRNO) fail("payload-after-terminal", status);
}
/* Serial compilation-info results occupy every fixed payload slot until the next one is refused. */
static void payload_slots(void) {
  uint32_t width, height;
  uint32_t surface = fixture_open(&width, &height);
  gpu_push_scope(&writer);
  gpu_shader(&writer, payload_wgsl);
  finish_scope(WAFFLE_GPU_ENUM_ERROR_TYPE_NO_ERROR);
  printf("GPU_PAYLOAD_READY connection=%u surface=%u shader=%u slots=%u\n",
         connection, surface, (unsigned)SHADER, (unsigned)WAFFLE_GPU_PAYLOAD_SLOTS);
  for (unsigned index = 1; index < WAFFLE_GPU_PAYLOAD_SLOTS; ++index) {
    uint32_t reply_token = next_token();
    payload_request(index, reply_token);
    payload_wait(index, reply_token);
  }
  uint32_t last_token = next_token();
  payload_request(WAFFLE_GPU_PAYLOAD_SLOTS, last_token);
  wait_stdin("payload-last-committed");
  payload_request(WAFFLE_GPU_PAYLOAD_SLOTS + 1, next_token());
  wait_stdin("payload-refusal-requested");
  PayloadDrain drained = {0};
  int32_t status = 0;
  while (!status) status = payload_terminal_batch(last_token, &drained);
  printf("GPU_PAYLOAD_TERMINAL reason=%u records=%u successes=%u closed=%u status=%d\n",
         drained.reason, drained.records, drained.successes, drained.closed, status);
  if (status != PAYLOAD_RESOURCE_ERRNO || drained.successes != 1 || drained.closed != 1 ||
      drained.reason != PAYLOAD_RESOURCE_REASON)
    fail("payload-terminal", status);
  payload_after_terminal(&drained);
  wait_stdin("payload-terminal");
  uint32_t closed = connection;
  check("payload-close", runtime_gpu_close(closed));
  connection = 0;
  check("payload-close-idempotent", runtime_gpu_close(closed));
  puts("GPU_STAGE closed");
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  options(argc, argv);
  if (grant_quota) { quota_reopen(); return 0; }
  if (payload_pressure) { payload_slots(); return 0; }
  uint32_t width, height;
  uint32_t surface_id = fixture_open(&width, &height);
  resources(surface_id, width, height);
  if (fairness) {
    if (fairness == FAIRNESS_HEAVY) fairness_heavy();
    if (fairness == FAIRNESS_PEER) fairness_peer();
    if (fairness == FAIRNESS_SEEDED) fairness_seeded();
    fixture_close();
    return 0;
  }
  if (split) {
    for (int i = 0; i < 3; ++i) {
      scope_barrier();
      printf("GPU_STAGE acquired-barrier index=%d\n", i + 1);
    }
  }
  if (pause_acquired) wait_stdin("acquired");
  GpuFixtureFrame presented = render();
  if (discard_after_first) presented = discard_frame();
  if (expired_frame_use) expired_use(&presented);
  wait_stdin("frame");
  fixture_close();
  return 0;
}
#endif
