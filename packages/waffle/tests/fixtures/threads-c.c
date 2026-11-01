#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

static _Atomic uint32_t main_static = 17;
static const uint32_t main_sentinel = 0x51a7c0de;
static _Thread_local uint32_t tls_value;
static _Atomic uint32_t progress;
static _Atomic uint32_t expected_progress;
static _Atomic uint32_t ready;
static _Atomic uint32_t release_children;
static _Atomic uintptr_t stack_addresses[2];
static _Atomic uintptr_t tls_addresses[2];

static void wait_for_release(void) {
  while (atomic_load_explicit(&release_children, memory_order_seq_cst) == 0) sched_yield();
}

static void *child(void *argument) {
  const uint32_t id = (uint32_t)(uintptr_t)argument;
  volatile uint32_t stack[4] = {id, id + 1, id + 2, id + 3};
  assert(atomic_load_explicit(&main_static, memory_order_seq_cst) == main_sentinel);
  tls_value = 100 + id;
  atomic_store_explicit(&stack_addresses[id - 1], (uintptr_t)&stack[0], memory_order_seq_cst);
  atomic_store_explicit(&tls_addresses[id - 1], (uintptr_t)&tls_value, memory_order_seq_cst);
  atomic_fetch_add_explicit(&progress, 1, memory_order_seq_cst);
  atomic_fetch_add_explicit(&ready, 1, memory_order_seq_cst);
  wait_for_release();
  assert(atomic_load_explicit(&progress, memory_order_seq_cst) ==
         atomic_load_explicit(&expected_progress, memory_order_seq_cst));
  assert(stack[0] == id);
  assert(tls_value == 100 + id);
  return (void *)(uintptr_t)(100 + id);
}

static void reset_pair(uint32_t expected) {
  atomic_store_explicit(&expected_progress, expected, memory_order_seq_cst);
  atomic_store_explicit(&progress, 0, memory_order_seq_cst);
  atomic_store_explicit(&ready, 0, memory_order_seq_cst);
  atomic_store_explicit(&release_children, 0, memory_order_seq_cst);
  atomic_store_explicit(&stack_addresses[0], 0, memory_order_seq_cst);
  atomic_store_explicit(&stack_addresses[1], 0, memory_order_seq_cst);
  atomic_store_explicit(&tls_addresses[0], 0, memory_order_seq_cst);
  atomic_store_explicit(&tls_addresses[1], 0, memory_order_seq_cst);
}

static void pair(void) {
  pthread_t first, second;
  void *first_result = NULL;
  void *second_result = NULL;
  reset_pair(2);
  assert(pthread_create(&first, NULL, child, (void *)(uintptr_t)1) == 0);
  assert(pthread_create(&second, NULL, child, (void *)(uintptr_t)2) == 0);
  while (atomic_load_explicit(&ready, memory_order_seq_cst) != 2) sched_yield();
  const uintptr_t first_stack = atomic_load_explicit(&stack_addresses[0], memory_order_seq_cst);
  const uintptr_t second_stack = atomic_load_explicit(&stack_addresses[1], memory_order_seq_cst);
  const uintptr_t first_tls = atomic_load_explicit(&tls_addresses[0], memory_order_seq_cst);
  const uintptr_t second_tls = atomic_load_explicit(&tls_addresses[1], memory_order_seq_cst);
  assert(first_stack != 0 && second_stack != 0 && first_stack != second_stack);
  assert(first_tls != 0 && second_tls != 0 && first_tls != second_tls);
  atomic_store_explicit(&release_children, 1, memory_order_seq_cst);
  assert(pthread_join(first, &first_result) == 0);
  assert(pthread_join(second, &second_result) == 0);
  assert((uintptr_t)first_result == 101);
  assert((uintptr_t)second_result == 102);
  assert(atomic_load_explicit(&progress, memory_order_seq_cst) == 2);
  assert(tls_value == 901);
  assert(atomic_load_explicit(&main_static, memory_order_seq_cst) == main_sentinel);
}

static void *nested_outer(void *unused) {
  pthread_t inner;
  void *result = NULL;
  (void)unused;
  tls_value = 701;
  assert(pthread_create(&inner, NULL, child, (void *)(uintptr_t)1) == 0);
  while (atomic_load_explicit(&ready, memory_order_seq_cst) != 1) sched_yield();
  atomic_store_explicit(&release_children, 1, memory_order_seq_cst);
  assert(pthread_join(inner, &result) == 0);
  assert((uintptr_t)result == 101);
  assert(tls_value == 701);
  return NULL;
}

static void nested(void) {
  pthread_t outer;
  reset_pair(1);
  assert(pthread_create(&outer, NULL, nested_outer, NULL) == 0);
  assert(pthread_join(outer, NULL) == 0);
  assert(atomic_load_explicit(&progress, memory_order_seq_cst) == 1);
  assert(tls_value == 901);
  assert(atomic_load_explicit(&main_static, memory_order_seq_cst) == main_sentinel);
}

static int run_mode(const char *mode) {
  atomic_store_explicit(&main_static, main_sentinel, memory_order_seq_cst);
  tls_value = 901;
  if (mode[0] == 'p' && mode[1] == 'a' && mode[2] == 'i' && mode[3] == 'r' && mode[4] == '\0') {
    pair();
  } else if (mode[0] == 'r' && mode[1] == 'e' && mode[2] == 'p' && mode[3] == 'e' && mode[4] == 'a' && mode[5] == 't' && mode[6] == '\0') {
    for (int i = 0; i < 8; i++) pair();
  } else if (mode[0] == 'n' && mode[1] == 'e' && mode[2] == 's' && mode[3] == 't' && mode[4] == 'e' && mode[5] == 'd' && mode[6] == '\0') {
    nested();
  } else {
    return 2;
  }
  puts("c-threads-ok");
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 2) return 2;
  return run_mode(argc == 2 ? argv[1] : "pair");
}
