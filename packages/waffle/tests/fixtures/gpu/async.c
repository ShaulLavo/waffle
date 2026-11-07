#include "async_encode.h"
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void require(int condition, const char *stage) {
  if (condition) return;
  fprintf(stderr, "GPU_ASYNC_FAIL stage=%s\n", stage);
  exit(1);
}
static void local_checks(void) {
  require(waffle_gpu_map_size(WGPU_WHOLE_MAP_SIZE) == UINT64_MAX, "c-sentinel");
  require(waffle_gpu_map_size(0) == 0 && waffle_gpu_map_size(16) == 16, "finite-map-size");
  AsyncShadow s = {.id = 20, .device = DEVICE, .size = 64, .offset = 8,
                   .length = 32, .state = ASYNC_WRITE};
  require(!async_range(&s, 8, WGPU_WHOLE_MAP_SIZE, 1), "partial-whole-bounds");
  require(!async_range(&s, 4, 4, 1) && !async_range(&s, 8, 2, 1), "range-alignment");
  require(!async_range(&s, 0, 8, 1) && !async_range(&s, 32, 12, 1), "range-bounds");
  void *a = async_range(&s, 8, 8, 1), *b = async_range(&s, 24, 8, 1);
  require(a && b && (uintptr_t)a % 16 == 0 && (uintptr_t)b % 16 == 0, "pointer-alignment");
  require(!async_range(&s, 8, 4, 1) && !async_range(&s, 16, 16, 1), "range-overlap");
  require(async_range(&s, 40, 0, 1) != NULL, "zero-range");
  async_invalidate(&s);
  require(!async_range(&s, 8, 8, 1), "invalidated-range");
  s.state = ASYNC_READ; s.offset = 0; s.length = 64;
  require(!async_range(&s, 0, 8, 1) && async_range(&s, 0, 8, 0), "read-is-const");
  const uint8_t truncated[] = {3, 0, 0, 0, 'x'};
  AsyncReader r = {truncated, sizeof(truncated), 0, 0};
  async_string(&r); require(r.error, "truncated-string");
  puts("GPU_ASYNC_LOCAL_OK sentinel=normalized ranges=checked reader=bounded");
}
static void vectors(void) {
  uint8_t data[256]; WaffleGpuWriter w = {data, sizeof(data), 0, 0};
  async_map(&w, 9, 7, WGPUMapMode_Write, 8, WGPU_WHOLE_MAP_SIZE);
  data[WAFFLE_GPU_BUFFER_MAP_ASYNC_RECEIVER_OFFSET + 4] = 3;
  printf("map ");
  for (size_t i = 0; i < w.offset; ++i) printf("%02x", data[i]);
  puts("");
  for (uint16_t opcode = 107; opcode <= 120; ++opcode) {
    if (opcode == 115 || opcode == 116) continue;
    w.offset = 0;
    if (opcode == 109 || opcode == 112 || opcode == 120) async_has(&w, opcode, 9, 7, 1);
    else async_query_end(&w, opcode, 9, 7);
    data[WAFFLE_GPU_ADAPTER_GET_INFO_RECEIVER_OFFSET + 4] = 3;
    printf("query-%u ", opcode);
    for (size_t i = 0; i < w.offset; ++i) printf("%02x", data[i]);
    puts("");
  }
  w.offset = 0; async_unmap(&w, 7);
  data[WAFFLE_GPU_BUFFER_UNMAP_RECEIVER_OFFSET + 4] = 3;
  printf("unmap ");
  for (size_t i = 0; i < w.offset; ++i) printf("%02x", data[i]);
  puts("");
  AsyncShadow shadow = {.id = 7, .device = DEVICE, .size = 64, .offset = 8,
                        .length = 4, .state = ASYNC_WRITE};
  uint8_t *range = async_range(&shadow, 8, 4, 1);
  require(range != NULL, "vector-shadow");
  for (size_t i = 0; i < 4; ++i) range[i] = (uint8_t)(i + 1);
  w.offset = 0; async_writeback(&w, &shadow, 0, 0);
  data[WAFFLE_GPU_BUFFER_UNMAP_WRITES_BUFFER_OFFSET + 4] = 3;
  printf("writes ");
  for (size_t i = 0; i < w.offset; ++i) printf("%02x", data[i]);
  puts("");
  require(!w.error, "vectors");
}
#ifdef GPU_ASYNC_LOCAL_ONLY
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--vectors") == 0) vectors();
  else local_checks();
  return 0;
}
#else
#define IMPORT(module, name) __attribute__((import_module(module), import_name(name)))
IMPORT("runtime_gpu", "open") extern int32_t runtime_gpu_open(uint32_t, void *);
IMPORT("runtime_gpu", "append") extern int32_t runtime_gpu_append(uint32_t, const void *, uint32_t);
IMPORT("runtime_gpu", "completions") extern int32_t runtime_gpu_completions(uint32_t, void *, uint32_t, int64_t, void *);
IMPORT("runtime_gpu", "payload") extern int32_t runtime_gpu_payload(uint32_t, const void *, void *, uint32_t);
IMPORT("runtime_gpu", "close") extern int32_t runtime_gpu_close(uint32_t);

static uint32_t connection, token, loss_device;
static uint8_t command_bytes[8192], payload_bytes[16384], reply_bytes[16384];
static WaffleGpuWriter writer = {command_bytes, sizeof(command_bytes), 0, 0};
static size_t reply_length, payload_length;
static int suppress_writes, corrupt_ranges, reuse_payload, malformed_map;
static const char *pause_stage = "";
static AsyncShadow source = {.id = 20, .device = DEVICE, .size = 64},
                   readback = {.id = 21, .device = DEVICE, .size = 64},
                   writable = {.id = 22, .device = DEVICE, .size = 64};
static uint64_t adapter_limits[WAFFLE_GPU_LIMITS_MAX_IMMEDIATE_SIZE_INDEX + 1];
static uint32_t adapter_features[128], device_features[128], wgsl_features[128];
static size_t adapter_feature_count, device_feature_count, wgsl_feature_count;
static const char invalid_wgsl[] =
  "@compute @workgroup_size(1) fn main() { /* λ😀 */ let value = ; }\n";
static void check(int32_t status, const char *stage) { require(status == 0, stage); }
static void cleanup(void) { if (connection) runtime_gpu_close(connection); }
static uint32_t next_token(void) { return ++token; }
static void append(void) {
  require(!writer.error && writer.offset, "command-encoding");
  check(runtime_gpu_append(connection, command_bytes, (uint32_t)writer.offset), "append");
  writer.offset = 0;
}
static void pause_at(const char *stage) {
  if (strcmp(stage, pause_stage)) return;
  printf("GPU_ASYNC_PAUSED stage=%s\n", stage);
  char byte; require(read(STDIN_FILENO, &byte, 1) == 1, "pause-input");
}
static void loss(const uint8_t *p, size_t length) {
  AsyncReader r = {p, length, WAFFLE_GPU_REPLY_DEVICE_LOST_DEVICE_OFFSET, 0};
  uint32_t id = async_u32(&r), generation = async_u32(&r), reason = async_u32(&r);
  AsyncString message = async_string(&r); async_end(&r, 8);
  require(!r.error && generation == 1 && id == DEVICE &&
          reason == WGPUDeviceLostReason_Destroyed, "loss-fields");
  loss_device = id;
  printf("GPU_ASYNC_LOSS device=%u reason=%u message=%.*s\n", id, reason,
         (int)message.length, message.data ? (const char *)message.data : "");
}
static int drain(uint32_t kind, uint32_t t, int64_t timeout) {
  uint32_t written = 0; uint8_t replies[16384];
  check(runtime_gpu_completions(connection, replies, sizeof(replies), timeout, &written), "completions");
  require(written <= sizeof(replies), "completion-span");
  size_t offset = 0; int found = 0;
  while (offset < written) {
    require(written - offset >= WAFFLE_GPU_COMPLETION_HEADER_SIZE, "completion-header");
    const uint8_t *p = replies + offset;
    uint32_t length = gpu_read_u32(p + 4), actual = p[0] | (uint32_t)p[1] << 8;
    require(!p[2] && !p[3] && length >= 16 && length % 8 == 0 && length <= written - offset,
            "completion-framing");
    if (actual == WAFFLE_GPU_REPLY_DEVICE_LOST && !gpu_read_u32(p + 8)) loss(p, length);
    else {
      if (actual == WAFFLE_GPU_REPLY_CLOSED && length >= 24)
        fprintf(stderr, "GPU_ASYNC_TERMINAL reason=%u\n", gpu_read_u32(p + WAFFLE_GPU_REPLY_CLOSED_REASON_OFFSET));
      if (actual != kind || gpu_read_u32(p + 8) != t || found)
        fprintf(stderr, "GPU_ASYNC_UNEXPECTED expected=%u token=%u actual=%u token=%u status=%d bytes=%u\n",
                kind, t, actual, gpu_read_u32(p + 8), (int32_t)gpu_read_u32(p + 12), length);
      require(actual == kind && gpu_read_u32(p + 8) == t && !found, "completion-correlation");
      memcpy(reply_bytes, p, length); reply_length = length; found = 1;
    }
    offset += length;
  }
  return found;
}
static void wait_for(uint32_t kind, uint32_t t) { while (!drain(kind, t, -1)) {} }
static AsyncReader reply_body(void) {
  return (AsyncReader){reply_bytes, reply_length, WAFFLE_GPU_COMPLETION_HEADER_SIZE, 0};
}
static void reply_ok(void) { require(gpu_read_u32(reply_bytes + 12) == 0, "bridge-status"); }
static void consume(AsyncReader *r) {
  uint32_t handle[2] = {async_u32(r), async_u32(r)};
  uint32_t length = async_u32(r);
  require(!r->error && handle[0] && handle[1] && length <= sizeof(payload_bytes) - 8, "payload-fields");
  memset(payload_bytes, 0xa5, sizeof(payload_bytes));
  require(runtime_gpu_payload(connection, handle, (void *)(uintptr_t)UINT32_MAX, 0) == -28,
          "invalid-payload-destination");
  if (length) require(runtime_gpu_payload(connection, handle, payload_bytes, length - 1) == -42,
                      "short-payload-destination");
  for (size_t i = 0; i < sizeof(payload_bytes); ++i) require(payload_bytes[i] == 0xa5, "failed-copy-mutated");
  check(runtime_gpu_payload(connection, handle, payload_bytes, length + 8), "payload-copy");
  for (size_t i = length; i < length + 8; ++i) require(payload_bytes[i] == 0xa5, "payload-tail");
  int32_t second = runtime_gpu_payload(connection, handle, payload_bytes, length);
  require(reuse_payload ? second == 0 : second == -8, "payload-once"); payload_length = length;
}
static void query(uint16_t opcode, uint32_t receiver, uint32_t feature) {
  uint32_t t = next_token();
  if (opcode == 109 || opcode == 112 || opcode == 120) async_has(&writer, opcode, t, receiver, feature);
  else async_query_end(&writer, opcode, t, receiver);
  append(); wait_for(WAFFLE_GPU_REPLY_QUERY_RESULT, t); reply_ok();
  AsyncReader r = reply_body(); require(async_u32(&r) == opcode, "query-opcode");
  consume(&r); async_end(&r, 8); require(!r.error, "query-reply");
}
static int limit64(size_t member) {
  return member == WAFFLE_GPU_LIMITS_MAX_UNIFORM_BUFFER_BINDING_SIZE_INDEX ||
         member == WAFFLE_GPU_LIMITS_MAX_STORAGE_BUFFER_BINDING_SIZE_INDEX ||
         member == WAFFLE_GPU_LIMITS_MAX_BUFFER_SIZE_INDEX;
}
static void limits(uint16_t opcode, uint32_t receiver, uint64_t *values) {
  query(opcode, receiver, 0); AsyncReader r = {payload_bytes, payload_length, 0, 0};
  require(async_u32(&r) == WGPUStatus_Success && async_u32(&r) == 0, "limits-status-chain");
  for (size_t i = 1; i <= WAFFLE_GPU_LIMITS_MAX_IMMEDIATE_SIZE_INDEX; ++i)
    values[i] = limit64(i) ? async_u64(&r) : async_u32(&r);
  async_end(&r, 1); require(!r.error, "limits-payload");
  require(values[WAFFLE_GPU_LIMITS_MAX_BUFFER_SIZE_INDEX] >= 64 &&
          values[WAFFLE_GPU_LIMITS_MAX_TEXTURE_DIMENSION_2D_INDEX] > 0, "limits-capability");
}
static size_t features(uint16_t opcode, uint32_t receiver, uint32_t *values) {
  query(opcode, receiver, 0); AsyncReader r = {payload_bytes, payload_length, 0, 0};
  uint32_t count = async_u32(&r); require(count <= 128, "feature-count");
  for (uint32_t i = 0; i < count; ++i) {
    values[i] = async_u32(&r); require(values[i] != 0, "feature-value");
    for (uint32_t j = 0; j < i; ++j) require(values[j] != values[i], "duplicate-feature");
  }
  async_end(&r, 1); require(!r.error, "features-void-layout"); return count;
}
static void has_features(uint16_t opcode, uint32_t receiver, const uint32_t *values, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    query(opcode, receiver, values[i]); AsyncReader r = {payload_bytes, payload_length, 0, 0};
    require(async_u32(&r) == 1, "has-feature"); async_end(&r, 1); require(!r.error, "boolean-payload");
  }
}
static void info(uint16_t opcode, uint32_t receiver) {
  query(opcode, receiver, 0); AsyncReader r = {payload_bytes, payload_length, 0, 0};
  require(async_u32(&r) == WGPUStatus_Success && async_u32(&r) == 0, "info-status-chain");
  AsyncString vendor = async_string(&r), architecture = async_string(&r);
  AsyncString device = async_string(&r), description = async_string(&r);
  require(async_u32(&r) == WGPUBackendType_WebGPU, "info-backend");
  uint32_t type = async_u32(&r), vendor_id = async_u32(&r), device_id = async_u32(&r);
  uint32_t minimum = async_u32(&r), maximum = async_u32(&r); async_end(&r, 1);
  require(!r.error && type && !vendor_id && !device_id && minimum <= maximum, "info-fields");
  printf("GPU_ASYNC_INFO opcode=%u vendor=%.*s architecture=%.*s device=%.*s description=%.*s\n",
         opcode, (int)vendor.length, (const char *)vendor.data,
         (int)architecture.length, (const char *)architecture.data,
         (int)device.length, (const char *)device.data,
         (int)description.length, (const char *)description.data);
}
static void request_result(uint32_t kind, uint32_t t, uint32_t id, int success) {
  wait_for(kind, t); AsyncReader r = reply_body();
  uint32_t status = async_u32(&r), result = async_u32(&r), generation = async_u32(&r);
  AsyncString message = async_string(&r); async_end(&r, 8); require(!r.error, "request-layout");
  int32_t bridge = (int32_t)gpu_read_u32(reply_bytes + 12);
  if (!success) {
    require(status == WGPURequestDeviceStatus_Error && message.length, "excessive-limit-granted");
    printf("GPU_ASYNC_EXCESSIVE status=%u bridge=%d message=%.*s\n", status, bridge,
           (int)message.length, (const char *)message.data);
    return;
  }
  if (bridge || status != 1) fprintf(stderr, "GPU_ASYNC_REQUEST id=%u status=%u bridge=%d message=%.*s\n",
    id, status, bridge, (int)message.length, (const char *)message.data);
  reply_ok(); require(status == 1 && result == id && generation == 1, "request-success");
}
static void request_adapter(uint32_t id) {
  uint32_t t = next_token();
  size_t start = waffle_gpu_begin(&writer, WAFFLE_GPU_OP_INSTANCE_REQUEST_ADAPTER);
  gpu_object(&writer, id); waffle_gpu_token(&writer, t); gpu_object(&writer, 1);
  waffle_gpu_u32(&writer, 0); waffle_gpu_end(&writer, start); append();
  request_result(WAFFLE_GPU_REPLY_ADAPTER, t, id, 1);
}
static void request_device(uint32_t id, uint32_t adapter, int excessive) {
  uint32_t t = next_token(); size_t start = waffle_gpu_begin(&writer, WAFFLE_GPU_OP_ADAPTER_REQUEST_DEVICE);
  gpu_object(&writer, id); waffle_gpu_token(&writer, t); gpu_object(&writer, adapter);
  waffle_gpu_u32(&writer, 1); gpu_label(&writer);
  waffle_gpu_u32(&writer, adapter_feature_count ? 1 : 0);
  if (adapter_feature_count) waffle_gpu_u32(&writer, adapter_features[0]);
  waffle_gpu_u32(&writer, 1); waffle_gpu_u32(&writer, 0);
  for (size_t i = 1; i <= WAFFLE_GPU_LIMITS_MAX_IMMEDIATE_SIZE_INDEX; ++i) {
    uint64_t value = limit64(i) ? UINT64_MAX : UINT32_MAX;
    if (i == WAFFLE_GPU_LIMITS_MAX_TEXTURE_DIMENSION_2D_INDEX)
      value = excessive ? adapter_limits[i] + 1 : adapter_limits[i];
    if (limit64(i)) waffle_gpu_u64(&writer, value);
    else waffle_gpu_u32(&writer, (uint32_t)value);
  }
  gpu_label(&writer); waffle_gpu_end(&writer, start); append();
  request_result(WAFFLE_GPU_REPLY_DEVICE, t, id, !excessive);
}
static void negotiate(void) {
  uint32_t t = next_token(); gpu_adapter(&writer, t); append();
  request_result(WAFFLE_GPU_REPLY_ADAPTER, t, ADAPTER, 1);
  info(WAFFLE_GPU_OP_ADAPTER_GET_INFO, ADAPTER);
  adapter_feature_count = features(WAFFLE_GPU_OP_ADAPTER_GET_FEATURES, ADAPTER, adapter_features);
  has_features(WAFFLE_GPU_OP_ADAPTER_HAS_FEATURE, ADAPTER, adapter_features, adapter_feature_count);
  limits(WAFFLE_GPU_OP_ADAPTER_GET_LIMITS, ADAPTER, adapter_limits);
  wgsl_feature_count = features(WAFFLE_GPU_OP_INSTANCE_GET_WGSL_LANGUAGE_FEATURES, 1, wgsl_features);
  has_features(WAFFLE_GPU_OP_INSTANCE_HAS_WGSL_LANGUAGE_FEATURE, 1, wgsl_features, wgsl_feature_count);
  request_device(DEVICE, ADAPTER, 0);
  device_feature_count = features(WAFFLE_GPU_OP_DEVICE_GET_FEATURES, DEVICE, device_features);
  require(device_feature_count == (adapter_feature_count ? 1u : 0u), "granted-features-count");
  if (device_feature_count) require(device_features[0] == adapter_features[0], "granted-feature");
  has_features(WAFFLE_GPU_OP_DEVICE_HAS_FEATURE, DEVICE, device_features, device_feature_count);
  uint64_t granted[WAFFLE_GPU_LIMITS_MAX_IMMEDIATE_SIZE_INDEX + 1] = {0};
  limits(WAFFLE_GPU_OP_DEVICE_GET_LIMITS, DEVICE, granted);
  require(granted[WAFFLE_GPU_LIMITS_MAX_TEXTURE_DIMENSION_2D_INDEX] ==
          adapter_limits[WAFFLE_GPU_LIMITS_MAX_TEXTURE_DIMENSION_2D_INDEX], "granted-limit");
  info(WAFFLE_GPU_OP_DEVICE_GET_ADAPTER_INFO, DEVICE); request_adapter(71); request_device(70, 71, 1);
  gpu_queue(&writer); append(); puts("GPU_ASYNC_NEGOTIATED granted=checked excessive=failed");
}
static void finish_scope(uint32_t expected) {
  uint32_t t = next_token(); gpu_pop_scope(&writer, t); append();
  wait_for(WAFFLE_GPU_REPLY_ERROR_SCOPE, t); reply_ok(); AsyncReader r = reply_body();
  require(async_u32(&r) == WGPUPopErrorScopeStatus_Success && async_u32(&r) == expected, "native-scope");
  AsyncString message = async_string(&r); async_end(&r, 8);
  require(!r.error && (expected == WGPUErrorType_NoError || message.length), "scope-layout");
}
static void work(uint32_t queue) {
  uint32_t t = next_token(); async_query_end(&writer, WAFFLE_GPU_OP_QUEUE_ON_SUBMITTED_WORK_DONE, t, queue);
  append(); pause_at("work-pending"); wait_for(WAFFLE_GPU_REPLY_QUEUE_WORK_RESULT, t); reply_ok();
  AsyncReader r = reply_body(); require(async_u32(&r) == WGPUQueueWorkDoneStatus_Success, "queue-status");
  AsyncString message = async_string(&r); async_end(&r, 8); require(!r.error && message.length == 0, "queue-layout");
}
static void map_shadow(AsyncShadow *s, uint64_t mode, size_t offset, size_t size) {
  uint32_t t = next_token(); s->state = ASYNC_PENDING;
  async_map(&writer, t, s->id, mode, offset, size);
  if (malformed_map) command_bytes[WAFFLE_GPU_BUFFER_MAP_ASYNC_TOKEN_OFFSET + 4] = 1;
  append(); pause_at("map-pending"); wait_for(WAFFLE_GPU_REPLY_MAP_RESULT, t); reply_ok();
  pause_at("payload-published"); AsyncReader r = reply_body();
  require(async_u32(&r) == WGPUMapAsyncStatus_Success, "map-status");
  async_string(&r); consume(&r); async_end(&r, 8);
  size_t expected = size == WGPU_WHOLE_MAP_SIZE ? s->size - offset : size;
  require(!r.error && payload_length == expected && payload_length <= sizeof(s->data), "map-bytes");
  memcpy(s->data, payload_bytes, payload_length);
  s->state = mode == WGPUMapMode_Write ? ASYNC_WRITE : ASYNC_READ;
  s->offset = offset; s->length = payload_length; s->count = 0;
}
static void unmap_read(AsyncShadow *s) { async_unmap(&writer, s->id); append(); async_invalidate(s); }
static void expect_read(const uint8_t expected[64], uint32_t base) {
  async_copy(&writer, source.id, readback.id, base, QUEUE); append(); work(QUEUE);
  map_shadow(&readback, WGPUMapMode_Read, 0, WGPU_WHOLE_MAP_SIZE);
  require(!async_range(&readback, 0, 64, 1), "mutable-read-getter");
  const void *p = async_range(&readback, 0, WGPU_WHOLE_MAP_SIZE, 0);
  require(p && memcmp(p, expected, 64) == 0, "exact-native-readback");
  memset(readback.data, 0xee, sizeof(readback.data)); unmap_read(&readback);
}
static void buffers(void) {
  source.usage = WGPUBufferUsage_CopySrc | WGPUBufferUsage_Vertex;
  readback.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
  writable.usage = WGPUBufferUsage_MapWrite | WGPUBufferUsage_CopySrc;
  gpu_push_scope(&writer);
  async_buffer(&writer, source.id, DEVICE, source.usage, 64, 1);
  async_buffer(&writer, readback.id, DEVICE, readback.usage, 64, 0);
  async_buffer(&writer, writable.id, DEVICE, writable.usage, 64, 0);
  finish_scope(WGPUErrorType_NoError); source.state = ASYNC_WRITE; source.length = 64;
  uint8_t zero[64] = {0}, creation[64] = {0}, expected[64] = {0};
  require(!memcmp(source.data, zero, 64), "creation-zero-shadow");
  gpu_push_scope(&writer); gpu_push_scope(&writer);
  async_copy(&writer, source.id, readback.id, 30, QUEUE);
  finish_scope(WGPUErrorType_Validation); finish_scope(WGPUErrorType_NoError);
  uint8_t *p = async_range(&source, 8, 8, 1), *q = async_range(&source, 24, 8, 1);
  require(p && q, "creation-ranges"); memset(p, 37, 8); memset(q, 61, 8);
  memset(creation + 8, 37, 8); memset(creation + 24, 61, 8);
  async_writeback(&writer, &source, suppress_writes, corrupt_ranges); append();
  if (corrupt_ranges) { drain(0, 0, -1); require(0, "corrupt-range-not-terminal"); }
  gpu_push_scope(&writer); expect_read(creation, 32); finish_scope(WGPUErrorType_NoError);
  puts("GPU_ASYNC_READBACK creation=exact zeros=preserved usages=unchanged");
  map_shadow(&writable, WGPUMapMode_Write, 0, WGPU_WHOLE_MAP_SIZE);
  require(!memcmp(writable.data, zero, 64), "first-write-map-zero");
  p = async_range(&writable, 8, 8, 1); require(p != NULL, "write-range"); memset(p, 53, 8);
  async_writeback(&writer, &writable, 0, 0); append();
  map_shadow(&writable, WGPUMapMode_Write, 0, 64); memset(expected + 8, 53, 8);
  require(!memcmp(writable.data, expected, 64), "write-remap-preserved");
  q = async_range(&writable, 24, 8, 1); require(q != NULL, "remap-range"); memset(q, 71, 8);
  memset(expected + 24, 71, 8); async_writeback(&writer, &writable, 0, 0); append();
  async_copy(&writer, writable.id, readback.id, 34, QUEUE); append(); work(QUEUE);
  map_shadow(&readback, WGPUMapMode_Read, 8, 24);
  require(!memcmp(readback.data, expected + 8, 24), "partial-initial-payload");
  require(!async_range(&readback, 8, WGPU_WHOLE_MAP_SIZE, 0), "partial-getter-bounds");
  require(async_range(&readback, 8, 24, 0) != NULL, "partial-getter"); unmap_read(&readback);
  map_shadow(&writable, WGPUMapMode_Write, 0, 0);
  require(async_range(&writable, 0, 0, 1) != NULL, "empty-map-pointer");
  async_writeback(&writer, &writable, 0, 0); append();
  puts("GPU_ASYNC_REMAP initial=preserved partial=checked empty=consumed");
  gpu_push_scope(&writer);
  async_buffer(&writer, 23, DEVICE, WGPUBufferUsage_MapWrite | WGPUBufferUsage_CopyDst, 64, 0);
  finish_scope(WGPUErrorType_Validation);
  gpu_push_scope(&writer); async_copy(&writer, source.id, 23, 36, QUEUE);
  finish_scope(WGPUErrorType_Validation);
  gpu_push_scope(&writer); expect_read(creation, 38); finish_scope(WGPUErrorType_NoError);
  puts("GPU_ASYNC_SCOPES mapped=validation invalid=validation dependent=validation recovered=yes");
}
static void compilation_message(AsyncReader *r, int *located) {
  require(async_u32(r) == 0, "compilation-message-chain"); AsyncString message = async_string(r);
  uint32_t severity = async_u32(r);
  uint64_t line = async_u64(r), column = async_u64(r), offset = async_u64(r), length = async_u64(r);
  require(!r->error && message.length && severity >= WGPUCompilationMessageType_Error &&
          severity <= WGPUCompilationMessageType_Info, "compilation-message");
  if (!line && !column && !offset && !length) return;
  size_t total = strlen(invalid_wgsl);
  require(line == 1 && column == offset + 1 && offset < total && length <= total - offset,
          "compilation-utf8-position");
  require(((uint8_t)invalid_wgsl[offset] & 0xc0) != 0x80 &&
          (offset + length == total || ((uint8_t)invalid_wgsl[offset + length] & 0xc0) != 0x80),
          "compilation-utf8-boundary");
  require(offset > (size_t)(strstr(invalid_wgsl, "λ") - invalid_wgsl), "nonascii-prefix");
  if (offset == (uint64_t)(strchr(invalid_wgsl, ';') - invalid_wgsl) && length == 1 &&
      severity == WGPUCompilationMessageType_Error) *located = 1;
}
static void compilation(void) {
  gpu_push_scope(&writer); gpu_shader(&writer, invalid_wgsl); finish_scope(WGPUErrorType_Validation);
  uint32_t t = next_token();
  async_query_end(&writer, WAFFLE_GPU_OP_SHADER_MODULE_GET_COMPILATION_INFO, t, SHADER); append();
  wait_for(WAFFLE_GPU_REPLY_COMPILATION_RESULT, t); reply_ok(); AsyncReader r = reply_body();
  require(async_u32(&r) == WGPUCompilationInfoRequestStatus_Success, "compilation-status");
  async_string(&r); consume(&r); async_end(&r, 8); require(!r.error, "compilation-reply");
  r = (AsyncReader){payload_bytes, payload_length, 0, 0};
  require(async_u32(&r) == 0, "compilation-info-chain");
  uint32_t count = async_u32(&r); require(count && count < 128, "compilation-count"); int located = 0;
  for (uint32_t i = 0; i < count; ++i) compilation_message(&r, &located);
  async_end(&r, 1); require(!r.error && located, "compilation-location-required");
  puts("GPU_ASYNC_COMPILATION native=error utf8=checked statuses=checked");
}
static void invalidate_device(uint32_t id) {
  if (source.device == id) async_invalidate(&source);
  if (readback.device == id) async_invalidate(&readback);
  if (writable.device == id) async_invalidate(&writable);
}
static void buffer_cache_lifetime(void) {
  AsyncShadow local = {.id = 24, .device = DEVICE, .size = 64, .length = 64, .state = ASYNC_WRITE};
  async_buffer(&writer, local.id, DEVICE, WGPUBufferUsage_CopySrc, 64, 1);
  require(async_range(&local, 0, 8, 1) != NULL, "before-buffer-destroy");
  async_receiver(&writer, WAFFLE_GPU_OP_BUFFER_DESTROY, local.id); async_invalidate(&local); append();
  require(!async_range(&local, 0, 8, 1), "buffer-destroy-invalidates");
  local.id = 25; local.state = ASYNC_WRITE; local.length = 64;
  async_buffer(&writer, local.id, DEVICE, WGPUBufferUsage_CopySrc, 64, 1);
  require(async_range(&local, 0, 8, 1) != NULL, "before-buffer-release");
  gpu_release(&writer, WAFFLE_GPU_OBJECT_BUFFER, local.id); async_invalidate(&local); append();
  require(!async_range(&local, 0, 8, 1), "last-buffer-release-invalidates");
}
static void device_loss(void) {
  request_adapter(72); request_device(60, 72, 0);
  size_t start = waffle_gpu_begin(&writer, WAFFLE_GPU_OP_DEVICE_GET_QUEUE);
  gpu_object(&writer, 61); gpu_object(&writer, 60); waffle_gpu_end(&writer, start);
  map_shadow(&writable, WGPUMapMode_Write, 0, WGPU_WHOLE_MAP_SIZE);
  async_receiver(&writer, WAFFLE_GPU_OP_DEVICE_DESTROY, DEVICE); invalidate_device(DEVICE); append();
  require(writable.state == ASYNC_UNMAPPED && !async_range(&writable, 0, 8, 1), "destroy-invalidates-cache");
  while (!loss_device) drain(0, 0, -1);
  work(61);
  query(WAFFLE_GPU_OP_DEVICE_HAS_FEATURE, 60, adapter_feature_count ? adapter_features[0] : WGPUFeatureName_DepthClipControl);
  require(payload_length == 4, "second-device-query");
  AsyncShadow secondary = {.id = 62, .device = 60, .size = 64, .length = 64, .state = ASYNC_WRITE};
  async_buffer(&writer, secondary.id, 60, WGPUBufferUsage_CopySrc, 64, 1);
  require(async_range(&secondary, 0, 8, 1) != NULL, "before-last-device-release");
  gpu_release(&writer, WAFFLE_GPU_OBJECT_DEVICE, 60); async_invalidate(&secondary); append();
  require(!async_range(&secondary, 0, 8, 1), "last-device-release-invalidates");
  puts("GPU_ASYNC_ISOLATION destroyed=unmapped second-device=progress last-release=invalidated");
}
int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0); local_checks();
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--local")) return 0;
    if (!strcmp(argv[i], "--vectors")) { vectors(); return 0; }
    if (!strcmp(argv[i], "--suppress-writes")) suppress_writes = 1;
    if (!strcmp(argv[i], "--corrupt-range")) corrupt_ranges = 1;
    if (!strcmp(argv[i], "--reuse-payload")) reuse_payload = 1;
    if (!strcmp(argv[i], "--malformed-map")) malformed_map = 1;
    if (!strcmp(argv[i], "--pause-map-pending")) pause_stage = "map-pending";
    if (!strcmp(argv[i], "--pause-payload-published")) pause_stage = "payload-published";
    if (!strcmp(argv[i], "--pause-work-pending")) pause_stage = "work-pending";
  }
  check(runtime_gpu_open(0, &connection), "open"); require(connection != 0, "connection");
  require(atexit(cleanup) == 0, "atexit");
  negotiate(); buffers(); compilation(); buffer_cache_lifetime(); device_loss(); drain(0, 0, 0);
  check(runtime_gpu_close(connection), "close"); connection = 0;
  puts("GPU_ASYNC_OK compiled=C runtime=blocking maps=exact scopes=native payload=once loss=explicit");
  return 0;
}
#endif
