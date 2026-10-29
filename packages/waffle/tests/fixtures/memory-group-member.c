// One relocated PIE member image of a memory group. Adapted from the Engines shared-memory
// prototype member.c (see docs/bun-patches.md): the heap grows through runtime_shm.group_grow
// and the page drives each member through a command block in the member's own statics.
#include <stddef.h>
#include <stdint.h>

#define IMPORT(module, name) __attribute__((import_module(module), import_name(name)))
IMPORT("runtime_shm", "group_grow") int32_t group_grow(uint32_t pages);
IMPORT("runtime_shm", "shm_create") int32_t shm_create(uint32_t len, uint32_t align, uint32_t *out);
IMPORT("runtime_shm", "shm_attach") int32_t shm_attach(uint32_t handle, uint32_t *out);
IMPORT("runtime_shm", "shm_detach") int32_t shm_detach(uint32_t handle);
IMPORT("runtime_shm", "shm_pin") int32_t shm_pin(uint32_t handle, uint32_t *out);
IMPORT("runtime_shm", "shm_route") int32_t shm_route(uint32_t pin, uint32_t pid);
IMPORT("runtime_shm", "shm_accept") int32_t shm_accept(uint32_t pin, uint32_t *out);
IMPORT("runtime_shm", "shm_unpin") int32_t shm_unpin(uint32_t pin);
IMPORT("runtime_shm", "futex_wait32") int32_t futex_wait32(uint32_t addr, int32_t expected, int64_t ns);
IMPORT("runtime_shm", "futex_wake") int32_t futex_wake(uint32_t addr, uint32_t count);
IMPORT("runtime_shm", "parallelism") int32_t parallelism(void);
IMPORT("runtime_proc", "getpid") int32_t getpid(void);
IMPORT("wasi_snapshot_preview1", "proc_exit") _Noreturn void proc_exit(int32_t code);
IMPORT("test", "ready") void ready(uint32_t command, int32_t pid);
extern void __wasm_call_ctors(void);

void *memset(void *d, int c, size_t n) { unsigned char *p = d; while (n--) *p++ = (unsigned char)c; return d; }
static int same(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return *a == *b; }

// Private heap on group_grow: each grow is its own member-owned chunk.
static unsigned char *heap_cursor, *heap_end;
static void *allocate(size_t n) {
  n = (n + 15) & ~(size_t)15;
  if ((size_t)(heap_end - heap_cursor) < n) {
    int32_t page = group_grow((uint32_t)((n + 65535) / 65536));
    if (page < 0) return 0;
    heap_cursor = (unsigned char *)((uintptr_t)page * 65536);
    heap_end = heap_cursor + ((n + 65535) / 65536) * 65536;
  }
  void *p = heap_cursor;
  heap_cursor += n;
  return p;
}

static int private_counter = 7;     // .data, per member
static char *greeting = "hello";    // pointer in .data: a data relocation
static int (*op)(int) = 0;          // table-relative function pointer
static int twice(int x) { return 2 * x; }
static int thrice(int x) { return 3 * x; }

__attribute__((noinline)) static int sum(volatile int *v, int n) { int s = 0; for (int i = 0; i < n; i++) s += v[i]; return s; }
__attribute__((noinline)) static void stack_probe(int id, int *total, uintptr_t *where) {
  volatile int local[64];
  for (int i = 0; i < 64; i++) local[i] = id;
  *total = sum(local, 64);
  *where = (uintptr_t)&local[0];
}

static int churn(int id, int rounds, uintptr_t *low, uintptr_t *high) {
  enum { N = 256 };
  static unsigned char *blocks[N];
  static size_t sizes[N];
  *low = UINTPTR_MAX;
  *high = 0;
  for (int r = 0; r < rounds; r++) {
    for (int i = 0; i < N; i++) {
      size_t n = 16 + ((i * 7919u + r * 104729u) % 20000u);
      if (!(blocks[i] = allocate(n))) return -1;
      sizes[i] = n;
      memset(blocks[i], id, n);
      if ((uintptr_t)blocks[i] < *low) *low = (uintptr_t)blocks[i];
      if ((uintptr_t)blocks[i] + n > *high) *high = (uintptr_t)blocks[i] + n;
    }
    for (int i = 0; i < N; i++)
      for (size_t j = 0; j < sizes[i]; j++)
        if (blocks[i][j] != (unsigned char)id) return -2;
  }
  return 0;
}

// [0] request seq (page), [1] done seq (member), [2] op, [3..6] args, [8..11] results.
static volatile int32_t command[16] __attribute__((aligned(16)));

static void run(void) {
  int32_t *a = (int32_t *)&command[3];
  int32_t *r = (int32_t *)&command[8];
  uint32_t out[3] = {0, 0, 0};
  int total = 0;
  uintptr_t low = 0, high = 0;
  for (int i = 0; i < 4; i++) r[i] = 0;
  switch (command[2]) {
    case 1:  // INIT(id, which)
      private_counter += a[0];
      op = a[1] ? thrice : twice;
      r[0] = private_counter;
      r[1] = (int32_t)(uintptr_t)&private_counter;
      r[2] = op(7);
      stack_probe(a[0], &total, &low);
      r[3] = (int32_t)low;
      if (total != 64 * a[0]) r[3] = -1;
      break;
    case 2:  // INFO
      r[0] = same(greeting, "hello");
      r[1] = parallelism();
      r[2] = getpid();
      break;
    case 3:  // CHURN(id, rounds)
      r[0] = churn(a[0], a[1], &low, &high);
      r[1] = (int32_t)low;
      r[2] = (int32_t)high;
      break;
    case 4: r[0] = shm_create((uint32_t)a[0], (uint32_t)a[1], out); r[1] = (int32_t)out[0]; r[2] = (int32_t)out[1]; break;
    case 5: r[0] = shm_attach((uint32_t)a[0], out); r[1] = (int32_t)out[0]; break;
    case 6: r[0] = shm_detach((uint32_t)a[0]); break;
    case 7: r[0] = shm_pin((uint32_t)a[0], out); r[1] = (int32_t)out[0]; break;
    case 8: r[0] = shm_route((uint32_t)a[0], (uint32_t)a[1]); break;
    case 9: r[0] = shm_accept((uint32_t)a[0], out); r[1] = (int32_t)out[0]; r[2] = (int32_t)out[1]; r[3] = (int32_t)out[2]; break;
    case 10: r[0] = shm_unpin((uint32_t)a[0]); break;
    case 11:  // WAIT32(addr, expected, timeout ms; negative waits forever)
      r[0] = futex_wait32((uint32_t)a[0], a[1], a[2] < 0 ? -1 : (int64_t)a[2] * 1000000);
      break;
    case 12: __atomic_store_n((int32_t *)(uintptr_t)a[0], a[1], __ATOMIC_SEQ_CST); break;
    case 13: r[0] = __atomic_load_n((int32_t *)(uintptr_t)a[0], __ATOMIC_SEQ_CST); break;
    case 14: r[0] = futex_wake((uint32_t)a[0], (uint32_t)a[1]); break;
    case 15: proc_exit(a[0]);
    case 16: r[0] = group_grow((uint32_t)a[0]); break;
    default: r[0] = -28;
  }
}

void _start(void) {
  __wasm_call_ctors();
  ready((uint32_t)(uintptr_t)command, getpid());
  int32_t last = 0;
  for (;;) {
    int32_t seq;
    while ((seq = __atomic_load_n(&command[0], __ATOMIC_SEQ_CST)) == last)
      futex_wait32((uint32_t)(uintptr_t)&command[0], last, -1);
    last = seq;
    run();
    __atomic_store_n(&command[1], seq, __ATOMIC_SEQ_CST);
    futex_wake((uint32_t)(uintptr_t)&command[1], 0xffffffffu);
  }
}
