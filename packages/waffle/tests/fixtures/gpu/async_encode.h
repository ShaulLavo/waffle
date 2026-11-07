#ifndef WAFFLE_GPU_ASYNC_ENCODE_H
#define WAFFLE_GPU_ASYNC_ENCODE_H
#include "gpu_encode.h"
#include "../../../browser/gpu/upstream/webgpu.h"

_Static_assert(WGPU_WHOLE_MAP_SIZE == SIZE_MAX, "upstream uses size_t sentinel");
#ifdef __wasm32__
_Static_assert(SIZE_MAX == UINT32_MAX, "acceptance must exercise wasm32 size_t");
#endif

typedef struct AsyncReader {
  const uint8_t *data;
  size_t length, offset;
  int error;
} AsyncReader;
typedef struct AsyncString { const uint8_t *data; uint32_t length; } AsyncString;
static inline void async_align(AsyncReader *r, size_t alignment) {
  size_t padding = (alignment - r->offset % alignment) % alignment;
  if (r->offset > r->length || padding > r->length - r->offset) { r->error = 1; return; }
  for (size_t i = 0; i < padding; ++i) if (r->data[r->offset + i]) r->error = 1;
  r->offset += padding;
}
static inline uint32_t async_u32(AsyncReader *r) {
  async_align(r, 4);
  if (r->error || r->offset > r->length || 4 > r->length - r->offset) { r->error = 1; return 0; }
  uint32_t value = gpu_read_u32(r->data + r->offset);
  r->offset += 4;
  return value;
}
static inline uint64_t async_u64(AsyncReader *r) {
  async_align(r, 8);
  uint64_t low = async_u32(r), high = async_u32(r);
  return low | high << 32;
}
static inline AsyncString async_string(AsyncReader *r) {
  uint32_t size = async_u32(r);
  if (r->error || r->offset > r->length || size > r->length - r->offset) {
    r->error = 1;
    return (AsyncString){NULL, 0};
  }
  AsyncString result = {r->data + r->offset, size};
  r->offset += size;
  async_align(r, 4);
  return result;
}
static inline void async_end(AsyncReader *r, size_t alignment) {
  async_align(r, alignment);
  if (r->offset != r->length) r->error = 1;
}
static inline size_t async_query(WaffleGpuWriter *w, uint16_t opcode, uint32_t t, uint32_t receiver) {
  size_t start = waffle_gpu_begin(w, opcode);
  waffle_gpu_token(w, t);
  gpu_object(w, receiver);
  return start;
}
static inline void async_query_end(WaffleGpuWriter *w, uint16_t opcode, uint32_t t, uint32_t receiver) {
  size_t start = async_query(w, opcode, t, receiver);
  waffle_gpu_end(w, start);
}
static inline void async_has(WaffleGpuWriter *w, uint16_t opcode, uint32_t t,
                             uint32_t receiver, uint32_t feature) {
  size_t start = async_query(w, opcode, t, receiver);
  waffle_gpu_u32(w, feature);
  waffle_gpu_end(w, start);
}
static inline void async_map(WaffleGpuWriter *w, uint32_t t, uint32_t buffer,
                             uint64_t mode, size_t offset, size_t size) {
  size_t start = async_query(w, WAFFLE_GPU_OP_BUFFER_MAP_ASYNC, t, buffer);
  waffle_gpu_u64(w, mode);
  waffle_gpu_u64(w, offset);
  waffle_gpu_u64(w, waffle_gpu_map_size(size));
  waffle_gpu_end(w, start);
}
static inline void async_unmap(WaffleGpuWriter *w, uint32_t buffer) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_BUFFER_UNMAP);
  gpu_object(w, buffer);
  waffle_gpu_end(w, start);
}
static inline void async_buffer(WaffleGpuWriter *w, uint32_t id, uint32_t device,
                                uint64_t usage, size_t size, int creation) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_DEVICE_CREATE_BUFFER);
  gpu_object(w, id);
  gpu_object(w, device);
  gpu_label(w);
  waffle_gpu_u64(w, usage);
  waffle_gpu_u64(w, size);
  waffle_gpu_u32(w, creation != 0);
  waffle_gpu_end(w, start);
}
static inline void async_receiver(WaffleGpuWriter *w, uint16_t opcode, uint32_t id) {
  size_t start = waffle_gpu_begin(w, opcode);
  gpu_object(w, id);
  waffle_gpu_end(w, start);
}

typedef enum AsyncMapState { ASYNC_UNMAPPED, ASYNC_PENDING, ASYNC_READ, ASYNC_WRITE } AsyncMapState;
typedef struct AsyncRange { size_t offset, length; } AsyncRange;
typedef struct AsyncShadow {
  uint32_t id, device;
  size_t size, offset, length;
  uint64_t usage;
  AsyncMapState state;
  _Alignas(16) uint8_t data[64];
  AsyncRange ranges[8];
  size_t count;
} AsyncShadow;
static inline void async_invalidate(AsyncShadow *s) {
  s->state = ASYNC_UNMAPPED;
  s->count = s->offset = s->length = 0;
  memset(s->data, 0, sizeof(s->data));
}
static inline void *async_range(AsyncShadow *s, size_t offset, size_t size, int mutable) {
  if (s->state != ASYNC_WRITE && s->state != ASYNC_READ) return NULL;
  if (mutable && s->state == ASYNC_READ) return NULL;
  if (offset % 8 || offset > s->size) return NULL;
  if (size == WGPU_WHOLE_MAP_SIZE) size = s->size - offset;
  if (size % 4 || offset < s->offset || offset - s->offset > s->length) return NULL;
  if (size > s->length - (offset - s->offset) || s->count == 8) return NULL;
  for (size_t i = 0; i < s->count; ++i) {
    AsyncRange prior = s->ranges[i];
    if (size && prior.length && offset < prior.offset + prior.length && prior.offset < offset + size)
      return NULL;
  }
  s->ranges[s->count++] = (AsyncRange){offset, size};
  return s->data + offset - s->offset;
}
static inline void async_writeback(WaffleGpuWriter *w, AsyncShadow *s, int suppress, int corrupt) {
  size_t start = waffle_gpu_begin(w, WAFFLE_GPU_OP_BUFFER_UNMAP_WRITES);
  gpu_object(w, s->id);
  size_t count = suppress ? 0 : s->count;
  waffle_gpu_u32(w, (uint32_t)count);
  for (size_t i = 0; i < count; ++i) {
    AsyncRange range = s->ranges[i];
    waffle_gpu_u64(w, range.offset + (corrupt && i + 1 == count ? 4 : 0));
    waffle_gpu_u32(w, (uint32_t)range.length);
    for (size_t j = 0; j < range.length; ++j)
      waffle_gpu_u8(w, s->data[range.offset - s->offset + j]);
  }
  waffle_gpu_end(w, start);
  async_invalidate(s);
}
static inline void async_copy(WaffleGpuWriter *w, uint32_t source, uint32_t destination,
                              uint32_t base, uint32_t queue) {
  uint8_t bytes[256];
  WaffleGpuWriter nested = {bytes, sizeof(bytes), 0, 0};
  gpu_created(w, WAFFLE_GPU_OP_DEVICE_CREATE_COMMAND_ENCODER, base, DEVICE);
  size_t start = waffle_gpu_begin(&nested, WAFFLE_GPU_OP_COMMAND_ENCODER_COPY_BUFFER_TO_BUFFER);
  gpu_object(&nested, source);
  waffle_gpu_u64(&nested, 0);
  gpu_object(&nested, destination);
  waffle_gpu_u64(&nested, 0);
  waffle_gpu_u64(&nested, 64);
  waffle_gpu_end(&nested, start);
  start = waffle_gpu_begin(&nested, WAFFLE_GPU_OP_COMMAND_ENCODER_FINISH);
  gpu_object(&nested, base + 1);
  waffle_gpu_u32(&nested, 0);
  waffle_gpu_end(&nested, start);
  start = waffle_gpu_begin(w, WAFFLE_GPU_OP_ENCODE);
  gpu_object(w, base);
  waffle_gpu_u32(w, (uint32_t)nested.offset);
  for (size_t i = 0; i < nested.offset; ++i) waffle_gpu_u8(w, bytes[i]);
  if (nested.error) w->error = 1;
  waffle_gpu_end(w, start);
  start = waffle_gpu_begin(w, WAFFLE_GPU_OP_QUEUE_SUBMIT);
  gpu_object(w, queue);
  waffle_gpu_u32(w, 1);
  gpu_object(w, base + 1);
  waffle_gpu_end(w, start);
}
#endif
