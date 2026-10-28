//! Lookup-only use of Waffle's executable access queries. Source admission accepts
//! these runtime_proc imports; no candidate module is loaded.
#[link(wasm_import_module = "runtime_proc")]
unsafe extern "C" {
    fn access_start(
        path: *const u8,
        length: usize,
        cwd: *const u8,
        cwd_length: usize,
        mode: i32,
    ) -> i32;
    fn access_take(request: u32) -> i32;
    fn access_cancel(request: u32) -> i32;
    fn poll(subscriptions: *const u8, count: usize, timeout: i32, events: *mut u8) -> i32;
}

struct Query(Option<u32>);
impl Drop for Query {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            unsafe { access_cancel(id) };
        }
    }
}

fn wait(id: u32) -> Result<(), i32> {
    // Four little-endian u32s: kind, request ID, userdata, reserved. Poll's
    // output is also exactly 16 bytes. Never depend on a Rust struct's layout.
    let mut subscription = [0u8; 16];
    subscription[..4].copy_from_slice(&5u32.to_le_bytes());
    subscription[4..8].copy_from_slice(&id.to_le_bytes());
    subscription[8..12].copy_from_slice(&1u32.to_le_bytes());
    let mut event = [0u8; 16];
    let result = unsafe { poll(subscription.as_ptr(), 1, -1, event.as_mut_ptr()) };
    if result < 0 {
        return Err(result);
    }
    Ok(())
}

pub fn registered(path: &str, cwd: &str) -> Result<bool, i32> {
    let request = unsafe { access_start(path.as_ptr(), path.len(), cwd.as_ptr(), cwd.len(), 1) };
    if request < 0 {
        return Err(request);
    }
    let id = request as u32;
    let mut query = Query(Some(id));
    loop {
        let result = unsafe { access_take(id) };
        if result == -6 {
            wait(id)?;
            continue;
        }
        query.0 = None;
        return match result {
            0 => Ok(true),
            -2 | -44 | -54 => Ok(false),
            errno if errno < 0 => Err(errno),
            _ => Err(-28),
        };
    }
}
