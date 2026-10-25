# File link counts

`FileStat.nlink` counts directory names that refer to a node. Opening a descriptor
does not add a link. A regular file with two names reports 2. After both names are
removed, an open descriptor reports 0 and can still read the file until close.
WASI path stat and descriptor stat expose this count.

Moving a name leaves its node's count unchanged. Replacing a name removes one
link from the displaced node. Renaming a name over another name for the same node
is a no-op. Restoring a persistent filesystem reconstructs counts from node
identity and namespace edges, without changing the stored format.

The root has one synthetic reference. Directory counts are namespace references,
not the Unix convention of 2 plus the number of child directories.
