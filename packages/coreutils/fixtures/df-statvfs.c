/* Calls the real wasi-libc functions on guest-owned paths and descriptors only. */
#include <errno.h>
#include <stdio.h>
#include <sys/statvfs.h>
int main(void) {
    struct statvfs usage;
    errno = 0;
    int path_result = statvfs("/owned", &usage);
    fprintf(stderr, "statvfs status=%d errno=%d\n", path_result, errno);
    errno = 0;
    int fd_result = fstatvfs(3, &usage);
    fprintf(stderr, "fstatvfs status=%d errno=%d\n", fd_result, errno);
    return path_result == 0 && fd_result == 0 ? 0 : 1;
}
