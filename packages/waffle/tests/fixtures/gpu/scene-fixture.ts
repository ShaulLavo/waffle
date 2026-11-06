export function bufferDescriptor(size = 64, usage = 40) {
  return { next_in_chain: [], label: "", usage, size, mapped_at_creation: false };
}
export function textureDescriptor(format = 22, usage = 6) {
  return {
    next_in_chain: [],
    label: "",
    usage,
    dimension: 2,
    size: { width: 2, height: 2, depth_or_array_layers: 1 },
    format,
    mip_level_count: 1,
    sample_count: 1,
    view_formats: [],
  };
}
export function samplerDescriptor() {
  return {
    next_in_chain: [],
    label: "",
    address_mode_u: 0,
    address_mode_v: 0,
    address_mode_w: 0,
    mag_filter: 0,
    min_filter: 0,
    mipmap_filter: 0,
    lod_min_clamp: 0,
    lod_max_clamp: 32,
    compare: 0,
    max_anisotropy: 1,
  };
}
export function layoutEntry(binding = 0) {
  return {
    next_in_chain: [],
    binding,
    visibility: 2,
    binding_array_size: 0,
    buffer: { next_in_chain: [], type: 0, has_dynamic_offset: false, min_binding_size: 0 },
    sampler: { next_in_chain: [], type: 0 },
    texture: { next_in_chain: [], sample_type: 0, view_dimension: 0, multisampled: false },
    storage_texture: { next_in_chain: [], access: 0, format: 0, view_dimension: 0 },
  };
}
export function depthStencil(view: { id: number; generation: number }) {
  return {
    next_in_chain: [],
    view,
    depth_load_op: 2,
    depth_store_op: 1,
    depth_clear_value: 1,
    depth_read_only: false,
    stencil_load_op: 0,
    stencil_store_op: 0,
    stencil_clear_value: 0,
    stencil_read_only: false,
  };
}
export function depthState(format = 46) {
  return {
    next_in_chain: [],
    format,
    depth_write_enabled: 1,
    depth_compare: 2,
    stencil_front: { compare: 0, fail_op: 0, depth_fail_op: 0, pass_op: 0 },
    stencil_back: { compare: 0, fail_op: 0, depth_fail_op: 0, pass_op: 0 },
    stencil_read_mask: 0xffffffff,
    stencil_write_mask: 0xffffffff,
    depth_bias: 0,
    depth_bias_slope_scale: 0,
    depth_bias_clamp: 0,
  };
}
