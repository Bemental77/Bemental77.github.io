struct UBO {
    idx: u32,
    uv: vec3<f32>,
}

@group(1) @binding(0) 
var samp_tex: binding_array<texture_2d_array<f32>, 8>;
@group(1) @binding(8) 
var samp_smp: binding_array<sampler, 8>;
var<private> ocol0_: vec4<f32>;
@group(0) @binding(0) 
var<uniform> u: UBO;

fn helper_u0028_u1_u003b_vf3_u003b(texmap: ptr<function, u32>, uv: ptr<function, vec3<f32>>) -> vec4<f32> {
    let _e9 = (*texmap);
    let _e11 = (*texmap);
    let _e13 = (*uv);
    let _e19 = textureSample(samp_tex[_e9], samp_smp[_e11], vec2<f32>(_e13.x, _e13.y), i32(_e13.z));
    return _e19;
}

fn main_1() {
    var param: u32;
    var param_1: vec3<f32>;

    let _e10 = u.idx;
    param = _e10;
    let _e12 = u.uv;
    param_1 = _e12;
    let _e13 = helper_u0028_u1_u003b_vf3_u003b((&param), (&param_1));
    ocol0_ = _e13;
    return;
}

@fragment 
fn main() -> @location(0) vec4<f32> {
    main_1();
    let _e1 = ocol0_;
    return _e1;
}
