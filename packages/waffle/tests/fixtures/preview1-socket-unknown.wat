(module
  (import "waffle_unknown" "connect" (func $missing))
  (memory (export "memory") 1)
  (func (export "_start") (call $missing)))
