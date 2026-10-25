//! PR116 ByteQueue, without its surrounding thread synchronization.
use std::collections::VecDeque;

#[derive(Default)]
pub struct ByteQueue(VecDeque<u8>);
impl ByteQueue {
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn push(&mut self, bytes: &[u8]) {
        self.0.extend(bytes);
    }
    pub fn take(&mut self, bytes: &mut [u8]) -> usize {
        let count = bytes.len().min(self.len());
        for byte in &mut bytes[..count] {
            *byte = self.0.pop_front().unwrap();
        }
        count
    }
    pub fn front(&mut self) -> &[u8] {
        self.0.make_contiguous()
    }
    pub fn consume(&mut self, count: usize) {
        self.0.drain(..count);
    }
}
