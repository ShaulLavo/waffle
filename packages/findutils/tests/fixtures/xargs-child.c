/* Original controlled test utility. Never installed as a program or host fallback. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef __wasm__
#include <signal.h>
#endif

#ifdef __wasm__
__attribute__((import_module("runtime_proc"), import_name("cwd")))
extern int process_cwd(char *, int);
__attribute__((import_module("runtime_proc"), import_name("getpid")))
extern int process_pid(void);
__attribute__((import_module("runtime_proc"), import_name("kill")))
extern int process_kill(int, int);
#endif

static void initialize_cwd(void) {
#ifdef __wasm__
    char path[4096];
    int length = process_cwd(path, sizeof(path) - 1);
    if (length < 0 || length >= sizeof(path)) exit(90);
    path[length] = 0;
    if (chdir(path)) exit(91);
#endif
}

static int dump(int argc, char **argv) {
    fwrite("CALL", 1, 5, stdout);
    for (int i = 2; i < argc; i++) fwrite(argv[i], 1, strlen(argv[i]) + 1, stdout);
    return 0;
}

static int copy_fd(int fd) {
    char bytes[128];
    ssize_t count;
    while ((count = read(fd, bytes, sizeof(bytes))) > 0) fwrite(bytes, 1, count, stdout);
    return count < 0 ? 92 : 0;
}

int main(int argc, char **argv) {
    initialize_cwd();
    if (argc < 2) return 0;
    if (!strcmp(argv[1], "dump")) return dump(argc, argv);
    if (!strcmp(argv[1], "stdin")) return copy_fd(0);
    if (!strcmp(argv[1], "fd7")) return copy_fd(7);
    if (!strcmp(argv[1], "status")) return atoi(argv[2]);
    if (!strcmp(argv[1], "sequence")) {
        puts(argv[2]);
        return atoi(argv[2]);
    }
    if (!strcmp(argv[1], "context")) {
        char cwd[4096];
        puts(getcwd(cwd, sizeof(cwd)));
        puts(getenv("XARGS_TEST_ENV"));
        return 0;
    }
    if (!strcmp(argv[1], "signal")) {
#ifdef __wasm__
        process_kill(process_pid(), atoi(argv[2]));
#else
        raise(atoi(argv[2]));
#endif
        return 93;
    }
    if (!strcmp(argv[1], "spin")) {
        puts("READY");
        fflush(stdout);
        for (;;) { __asm__ volatile(""); }
    }
    return 94;
}
