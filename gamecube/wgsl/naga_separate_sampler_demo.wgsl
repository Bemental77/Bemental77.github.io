var<private> o: vec4<f32>;
@group(0) @binding(0) 
var tex0_: texture_2d_array<f32>;
@group(0) @binding(1) 
var samp0_: sampler;
var<private> uv_1: vec3<f32>;

fn main_1() {
    let _e4 = uv_1;
    let _e10 = textureSample(tex0_, samp0_, vec2<f32>(_e4.x, _e4.y), i32(_e4.z));
    o = _e10;
    return;
}

@fragment 
fn main(@location(0) uv: vec3<f32>) -> @location(0) vec4<f32> {
    uv_1 = uv;
    main_1();
    let _e3 = o;
    return _e3;
}
