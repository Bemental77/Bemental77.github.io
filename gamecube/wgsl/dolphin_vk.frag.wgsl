enable dual_source_blending;

struct State {
    Reg: array<vec4<i32>, 4>,
    RawTexColor: vec4<i32>,
    TexColor: vec4<i32>,
    AlphaBump: i32,
}

struct StageState {
    stage: u32,
    order: u32,
    cc: u32,
    ac: u32,
}

struct PSBlock {
    color: array<vec4<i32>, 4>,
    k: array<vec4<i32>, 4>,
    alphaRef: vec4<i32>,
    texdim: array<vec4<i32>, 8>,
    czbias: array<vec4<i32>, 2>,
    cindscale: array<vec4<i32>, 2>,
    cindmtx: array<vec4<i32>, 6>,
    cfogcolor: vec4<i32>,
    cfogi: vec4<i32>,
    cfogf: vec4<f32>,
    cfogrange: array<vec4<f32>, 3>,
    czslope: vec4<f32>,
    cefbscale: vec2<f32>,
    bpmem_genmode: u32,
    bpmem_alphaTest: u32,
    bpmem_fogParam3_: u32,
    bpmem_fogRangeBase: u32,
    bpmem_dstalpha: u32,
    bpmem_ztex_op: u32,
    bpmem_late_ztest: u32,
    bpmem_rgba6_format: u32,
    bpmem_dither: u32,
    bpmem_bounding_box: u32,
    bpmem_pack1_: array<vec4<u32>, 16>,
    bpmem_pack2_: array<vec4<u32>, 8>,
    konstLookup: array<vec4<i32>, 32>,
    blend_enable: u32,
    blend_src_factor: u32,
    blend_src_factor_alpha: u32,
    blend_dst_factor: u32,
    blend_dst_factor_alpha: u32,
    blend_subtract: u32,
    blend_subtract_alpha: u32,
    logic_op_enable: u32,
    logic_op_mode: u32,
    time_ms: u32,
}

struct FragmentOutput {
    @location(0) @blend_src(0) member: vec4<f32>,
    @location(0) @blend_src(1) member_1: vec4<f32>,
}

@group(0) @binding(0) 
var<uniform> unnamed: PSBlock;
@group(1) @binding(0) 
var samp_tex0_: texture_2d_array<f32>;
@group(1) @binding(8) 
var samp_smp0_: sampler;
@group(1) @binding(1) 
var samp_tex1_: texture_2d_array<f32>;
@group(1) @binding(9) 
var samp_smp1_: sampler;
@group(1) @binding(2) 
var samp_tex2_: texture_2d_array<f32>;
@group(1) @binding(10) 
var samp_smp2_: sampler;
@group(1) @binding(3) 
var samp_tex3_: texture_2d_array<f32>;
@group(1) @binding(11) 
var samp_smp3_: sampler;
@group(1) @binding(4) 
var samp_tex4_: texture_2d_array<f32>;
@group(1) @binding(12) 
var samp_smp4_: sampler;
@group(1) @binding(5) 
var samp_tex5_: texture_2d_array<f32>;
@group(1) @binding(13) 
var samp_smp5_: sampler;
@group(1) @binding(6) 
var samp_tex6_: texture_2d_array<f32>;
@group(1) @binding(14) 
var samp_smp6_: sampler;
@group(1) @binding(7) 
var samp_tex7_: texture_2d_array<f32>;
@group(1) @binding(15) 
var samp_smp7_: sampler;
var<private> gl_FragCoord_1: vec4<f32>;
var<private> tex0_1: vec3<f32>;
var<private> tex1_1: vec3<f32>;
var<private> tex2_1: vec3<f32>;
var<private> tex3_1: vec3<f32>;
var<private> tex4_1: vec3<f32>;
var<private> tex5_1: vec3<f32>;
var<private> tex6_1: vec3<f32>;
var<private> tex7_1: vec3<f32>;
var<private> colors_0_4: vec4<f32>;
var<private> colors_1_4: vec4<f32>;
var<private> clipPos_1: vec4<f32>;
var<private> ocol0_: vec4<f32>;
var<private> ocol1_: vec4<f32>;

fn iround_u0028_f1_u003b(x: ptr<function, f32>) -> i32 {
    let _e108 = (*x);
    return i32(round(_e108));
}

fn alphaCompare_u0028_i1_u003b_i1_u003b_u1_u003b(a: ptr<function, i32>, b: ptr<function, i32>, compare: ptr<function, u32>) -> bool {
    let _e110 = (*compare);
    if (_e110 < 4u) {
        let _e112 = (*compare);
        if (_e112 < 2u) {
            let _e114 = (*compare);
            if (_e114 < 1u) {
                return false;
            } else {
                let _e116 = (*a);
                let _e117 = (*b);
                return (_e116 < _e117);
            }
        } else {
            let _e119 = (*compare);
            if (_e119 < 3u) {
                let _e121 = (*a);
                let _e122 = (*b);
                return (_e121 == _e122);
            } else {
                let _e124 = (*a);
                let _e125 = (*b);
                return (_e124 <= _e125);
            }
        }
    } else {
        let _e127 = (*compare);
        if (_e127 < 6u) {
            let _e129 = (*compare);
            if (_e129 < 5u) {
                let _e131 = (*a);
                let _e132 = (*b);
                return (_e131 > _e132);
            } else {
                let _e134 = (*a);
                let _e135 = (*b);
                return (_e134 != _e135);
            }
        } else {
            let _e137 = (*compare);
            if (_e137 < 7u) {
                let _e139 = (*a);
                let _e140 = (*b);
                return (_e139 >= _e140);
            } else {
                return true;
            }
        }
    }
}

fn idot_u0028_vi4_u003b_vi4_u003b(x_1: ptr<function, vec4<i32>>, y: ptr<function, vec4<i32>>) -> i32 {
    var tmp: vec4<i32>;

    let _e110 = (*x_1);
    let _e111 = (*y);
    tmp = (_e110 * _e111);
    let _e114 = tmp[0u];
    let _e116 = tmp[1u];
    let _e119 = tmp[2u];
    let _e122 = tmp[3u];
    return (((_e114 + _e116) + _e119) + _e122);
}

fn getTevReg_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_u1_u003b(s: ptr<function, State>, index: ptr<function, u32>) -> vec4<i32> {
    let _e109 = (*index);
    if (_e109 < 2u) {
        let _e111 = (*index);
        if (_e111 < 1u) {
            let _e115 = (*s).Reg[0i];
            return _e115;
        } else {
            let _e118 = (*s).Reg[1i];
            return _e118;
        }
    } else {
        let _e119 = (*index);
        if (_e119 < 3u) {
            let _e123 = (*s).Reg[2i];
            return _e123;
        } else {
            let _e126 = (*s).Reg[3i];
            return _e126;
        }
    }
}

fn tevLerp_u0028_i1_u003b_i1_u003b_i1_u003b_i1_u003b_u1_u003b_b1_u003b_u1_u003b(A: ptr<function, i32>, B: ptr<function, i32>, C: ptr<function, i32>, D: ptr<function, i32>, bias: ptr<function, u32>, op: ptr<function, bool>, scale: ptr<function, u32>) -> i32 {
    var mix_: i32;
    var result: i32;

    let _e116 = (*C);
    let _e119 = (*C);
    (*C) = (_e119 + (_e116 >> bitcast<u32>(7i)));
    let _e121 = (*bias);
    if (_e121 == 1u) {
        let _e123 = (*D);
        (*D) = (_e123 + 128i);
    } else {
        let _e125 = (*bias);
        if (_e125 == 2u) {
            let _e127 = (*D);
            (*D) = (_e127 - 128i);
        }
    }
    let _e129 = (*A);
    let _e132 = (*B);
    let _e133 = (*A);
    let _e135 = (*C);
    mix_ = ((_e129 << bitcast<u32>(8i)) + ((_e132 - _e133) * _e135));
    let _e138 = (*scale);
    if (_e138 != 3u) {
        let _e140 = mix_;
        let _e141 = (*scale);
        mix_ = (_e140 << bitcast<u32>(_e141));
        let _e144 = (*D);
        let _e145 = (*scale);
        (*D) = (_e144 << bitcast<u32>(_e145));
    }
    let _e148 = (*scale);
    if (_e148 != 3u) {
        let _e150 = mix_;
        let _e151 = (*op);
        mix_ = (_e150 + select(128i, 127i, _e151));
    }
    let _e154 = mix_;
    result = (_e154 >> bitcast<u32>(8i));
    let _e157 = (*op);
    if _e157 {
        let _e158 = (*D);
        let _e159 = result;
        result = (_e158 - _e159);
    } else {
        let _e161 = (*D);
        let _e162 = result;
        result = (_e161 + _e162);
    }
    let _e164 = (*scale);
    if (_e164 == 3u) {
        let _e166 = result;
        result = (_e166 >> bitcast<u32>(1i));
    }
    let _e169 = result;
    return _e169;
}

fn getKonstColor_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b(s_1: ptr<function, State>, ss: ptr<function, StageState>) -> vec4<i32> {
    var tevksel: u32;

    let _e111 = (*ss).stage;
    let _e117 = unnamed.bpmem_pack2_[(_e111 >> bitcast<u32>(1i))][1u];
    tevksel = _e117;
    let _e119 = (*ss).stage;
    if ((_e119 & 1u) == 0u) {
        let _e122 = tevksel;
        let _e128 = unnamed.konstLookup[extractBits(_e122, bitcast<u32>(4i), bitcast<u32>(5i))];
        let _e129 = _e128.xyz;
        let _e130 = tevksel;
        let _e137 = unnamed.konstLookup[extractBits(_e130, bitcast<u32>(9i), bitcast<u32>(5i))][3u];
        return vec4<i32>(_e129.x, _e129.y, _e129.z, _e137);
    } else {
        let _e142 = tevksel;
        let _e148 = unnamed.konstLookup[extractBits(_e142, bitcast<u32>(14i), bitcast<u32>(5i))];
        let _e149 = _e148.xyz;
        let _e150 = tevksel;
        let _e157 = unnamed.konstLookup[extractBits(_e150, bitcast<u32>(19i), bitcast<u32>(5i))][3u];
        return vec4<i32>(_e149.x, _e149.y, _e149.z, _e157);
    }
}

fn Swizzle_u0028_u1_u003b_vi4_u003b(s_2: ptr<function, u32>, color: ptr<function, vec4<i32>>) -> vec4<i32> {
    var ret: vec4<i32>;

    let _e110 = (*s_2);
    let _e115 = unnamed.bpmem_pack2_[(_e110 * 2u)][1u];
    let _e120 = (*color)[extractBits(_e115, bitcast<u32>(0i), bitcast<u32>(2i))];
    ret[0u] = _e120;
    let _e122 = (*s_2);
    let _e127 = unnamed.bpmem_pack2_[(_e122 * 2u)][1u];
    let _e132 = (*color)[extractBits(_e127, bitcast<u32>(2i), bitcast<u32>(2i))];
    ret[1u] = _e132;
    let _e134 = (*s_2);
    let _e140 = unnamed.bpmem_pack2_[((_e134 * 2u) + 1u)][1u];
    let _e145 = (*color)[extractBits(_e140, bitcast<u32>(0i), bitcast<u32>(2i))];
    ret[2u] = _e145;
    let _e147 = (*s_2);
    let _e153 = unnamed.bpmem_pack2_[((_e147 * 2u) + 1u)][1u];
    let _e158 = (*color)[extractBits(_e153, bitcast<u32>(2i), bitcast<u32>(2i))];
    ret[3u] = _e158;
    let _e160 = ret;
    return _e160;
}

fn iround_u0028_vf4_u003b(x_2: ptr<function, vec4<f32>>) -> vec4<i32> {
    let _e108 = (*x_2);
    return vec4<i32>(round(_e108));
}

fn getRasColor_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b(s_3: ptr<function, State>, ss_1: ptr<function, StageState>, colors_0_1: ptr<function, vec4<f32>>, colors_1_1: ptr<function, vec4<f32>>) -> vec4<i32> {
    var ras: u32;
    var color_1: vec4<i32>;
    var param: vec4<f32>;
    var swap: u32;
    var param_1: u32;
    var param_2: vec4<i32>;
    var normalized: i32;

    let _e119 = (*ss_1).order;
    ras = extractBits(_e119, bitcast<u32>(7i), bitcast<u32>(3i));
    let _e123 = ras;
    if (_e123 < 2u) {
        let _e125 = ras;
        let _e127 = (*colors_0_1);
        let _e128 = (*colors_1_1);
        param = (select(_e128, _e127, vec4((_e125 == 0u))) * 255f);
        let _e132 = iround_u0028_vf4_u003b((&param));
        color_1 = _e132;
        let _e134 = (*ss_1).ac;
        swap = extractBits(_e134, bitcast<u32>(0i), bitcast<u32>(2i));
        let _e138 = swap;
        param_1 = _e138;
        let _e139 = color_1;
        param_2 = _e139;
        let _e140 = Swizzle_u0028_u1_u003b_vi4_u003b((&param_1), (&param_2));
        return _e140;
    } else {
        let _e141 = ras;
        if (_e141 == 5u) {
            let _e144 = (*s_3).AlphaBump;
            let _e146 = (*s_3).AlphaBump;
            let _e148 = (*s_3).AlphaBump;
            let _e150 = (*s_3).AlphaBump;
            return vec4<i32>(_e144, _e146, _e148, _e150);
        } else {
            let _e152 = ras;
            if (_e152 == 6u) {
                let _e155 = (*s_3).AlphaBump;
                let _e157 = (*s_3).AlphaBump;
                normalized = (_e155 | (_e157 >> bitcast<u32>(5i)));
                let _e161 = normalized;
                let _e162 = normalized;
                let _e163 = normalized;
                let _e164 = normalized;
                return vec4<i32>(_e161, _e162, _e163, _e164);
            } else {
                return vec4<i32>(0i, 0i, 0i, 0i);
            }
        }
    }
}

fn selectAlphaInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b(s_4: ptr<function, State>, ss_2: ptr<function, StageState>, colors_0_2: ptr<function, vec4<f32>>, colors_1_2: ptr<function, vec4<f32>>, index_1: ptr<function, u32>) -> i32 {
    var param_3: State;
    var param_4: StageState;
    var param_5: vec4<f32>;
    var param_6: vec4<f32>;
    var param_7: State;
    var param_8: StageState;

    let _e118 = (*index_1);
    if (_e118 < 4u) {
        let _e120 = (*index_1);
        if (_e120 < 2u) {
            let _e122 = (*index_1);
            if (_e122 < 1u) {
                let _e127 = (*s_4).Reg[0i][3u];
                return _e127;
            } else {
                let _e131 = (*s_4).Reg[1i][3u];
                return _e131;
            }
        } else {
            let _e132 = (*index_1);
            if (_e132 < 3u) {
                let _e137 = (*s_4).Reg[2i][3u];
                return _e137;
            } else {
                let _e141 = (*s_4).Reg[3i][3u];
                return _e141;
            }
        }
    } else {
        let _e142 = (*index_1);
        if (_e142 < 6u) {
            let _e144 = (*index_1);
            if (_e144 < 5u) {
                let _e148 = (*s_4).TexColor[3u];
                return _e148;
            } else {
                let _e149 = (*s_4);
                param_3 = _e149;
                let _e150 = (*ss_2);
                param_4 = _e150;
                let _e151 = (*colors_0_2);
                param_5 = _e151;
                let _e152 = (*colors_1_2);
                param_6 = _e152;
                let _e153 = getRasColor_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b((&param_3), (&param_4), (&param_5), (&param_6));
                return _e153.w;
            }
        } else {
            let _e155 = (*index_1);
            if (_e155 < 7u) {
                let _e157 = (*s_4);
                param_7 = _e157;
                let _e158 = (*ss_2);
                param_8 = _e158;
                let _e159 = getKonstColor_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b((&param_7), (&param_8));
                return _e159.w;
            } else {
                return 0i;
            }
        }
    }
}

fn tevCompare_u0028_u1_u003b_vi3_u003b_vi3_u003b(op_1: ptr<function, u32>, color_A: ptr<function, vec3<i32>>, color_B: ptr<function, vec3<i32>>) -> bool {
    var A_16_: i32;
    var B_16_: i32;
    var A_24_: i32;
    var B_24_: i32;
    var phi_1015_: bool;
    var phi_1055_: bool;
    var phi_1063_: bool;

    let _e114 = (*op_1);
    switch bitcast<i32>(_e114) {
        case 0: {
            let _e117 = (*color_A)[0u];
            let _e119 = (*color_B)[0u];
            return (_e117 > _e119);
        }
        case 1: {
            let _e122 = (*color_A)[0u];
            let _e124 = (*color_B)[0u];
            return (_e122 == _e124);
        }
        case 2: {
            let _e127 = (*color_A)[0u];
            let _e129 = (*color_A)[1u];
            A_16_ = (_e127 | (_e129 << bitcast<u32>(8i)));
            let _e134 = (*color_B)[0u];
            let _e136 = (*color_B)[1u];
            B_16_ = (_e134 | (_e136 << bitcast<u32>(8i)));
            let _e140 = A_16_;
            let _e141 = B_16_;
            return (_e140 > _e141);
        }
        case 3: {
            let _e144 = (*color_A)[0u];
            let _e146 = (*color_B)[0u];
            let _e147 = (_e144 == _e146);
            phi_1015_ = _e147;
            if _e147 {
                let _e149 = (*color_A)[1u];
                let _e151 = (*color_B)[1u];
                phi_1015_ = (_e149 == _e151);
            }
            let _e154 = phi_1015_;
            return _e154;
        }
        case 4: {
            let _e156 = (*color_A)[0u];
            let _e158 = (*color_A)[1u];
            let _e163 = (*color_A)[2u];
            A_24_ = ((_e156 | (_e158 << bitcast<u32>(8i))) | (_e163 << bitcast<u32>(16i)));
            let _e168 = (*color_B)[0u];
            let _e170 = (*color_B)[1u];
            let _e175 = (*color_B)[2u];
            B_24_ = ((_e168 | (_e170 << bitcast<u32>(8i))) | (_e175 << bitcast<u32>(16i)));
            let _e179 = A_24_;
            let _e180 = B_24_;
            return (_e179 > _e180);
        }
        case 5: {
            let _e183 = (*color_A)[0u];
            let _e185 = (*color_B)[0u];
            let _e186 = (_e183 == _e185);
            phi_1055_ = _e186;
            if _e186 {
                let _e188 = (*color_A)[1u];
                let _e190 = (*color_B)[1u];
                phi_1055_ = (_e188 == _e190);
            }
            let _e193 = phi_1055_;
            phi_1063_ = _e193;
            if _e193 {
                let _e195 = (*color_A)[2u];
                let _e197 = (*color_B)[2u];
                phi_1063_ = (_e195 == _e197);
            }
            let _e200 = phi_1063_;
            return _e200;
        }
        default: {
            return false;
        }
    }
}

fn tevLerp3_u0028_vi3_u003b_vi3_u003b_vi3_u003b_vi3_u003b_u1_u003b_b1_u003b_u1_u003b(A_1: ptr<function, vec3<i32>>, B_1: ptr<function, vec3<i32>>, C_1: ptr<function, vec3<i32>>, D_1: ptr<function, vec3<i32>>, bias_1: ptr<function, u32>, op_2: ptr<function, bool>, scale_1: ptr<function, u32>) -> vec3<i32> {
    var mix_1: vec3<i32>;
    var result_1: vec3<i32>;

    let _e116 = (*C_1);
    let _e120 = (*C_1);
    (*C_1) = (_e120 + (_e116 >> bitcast<vec3<u32>>(vec3(7i))));
    let _e122 = (*bias_1);
    if (_e122 == 1u) {
        let _e124 = (*D_1);
        (*D_1) = (_e124 + vec3(128i));
    } else {
        let _e127 = (*bias_1);
        if (_e127 == 2u) {
            let _e129 = (*D_1);
            (*D_1) = (_e129 - vec3(128i));
        }
    }
    let _e132 = (*A_1);
    let _e136 = (*B_1);
    let _e137 = (*A_1);
    let _e139 = (*C_1);
    mix_1 = ((_e132 << bitcast<vec3<u32>>(vec3(8i))) + ((_e136 - _e137) * _e139));
    let _e142 = (*scale_1);
    if (_e142 != 3u) {
        let _e144 = mix_1;
        let _e145 = (*scale_1);
        mix_1 = (_e144 << bitcast<vec3<u32>>(vec3(_e145)));
        let _e149 = (*D_1);
        let _e150 = (*scale_1);
        (*D_1) = (_e149 << bitcast<vec3<u32>>(vec3(_e150)));
    }
    let _e154 = (*scale_1);
    if (_e154 != 3u) {
        let _e156 = mix_1;
        let _e157 = (*op_2);
        mix_1 = (_e156 + vec3(select(128i, 127i, _e157)));
    }
    let _e161 = mix_1;
    result_1 = (_e161 >> bitcast<vec3<u32>>(vec3(8i)));
    let _e165 = (*op_2);
    if _e165 {
        let _e166 = (*D_1);
        let _e167 = result_1;
        result_1 = (_e166 - _e167);
    } else {
        let _e169 = (*D_1);
        let _e170 = result_1;
        result_1 = (_e169 + _e170);
    }
    let _e172 = (*scale_1);
    if (_e172 == 3u) {
        let _e174 = result_1;
        result_1 = (_e174 >> bitcast<vec3<u32>>(vec3(1i)));
    }
    let _e178 = result_1;
    return _e178;
}

fn selectColorInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b(s_5: ptr<function, State>, ss_3: ptr<function, StageState>, colors_0_3: ptr<function, vec4<f32>>, colors_1_3: ptr<function, vec4<f32>>, index_2: ptr<function, u32>) -> vec3<i32> {
    var param_9: State;
    var param_10: StageState;
    var param_11: vec4<f32>;
    var param_12: vec4<f32>;
    var param_13: State;
    var param_14: StageState;
    var param_15: vec4<f32>;
    var param_16: vec4<f32>;
    var param_17: State;
    var param_18: StageState;

    let _e122 = (*index_2);
    if (_e122 < 8u) {
        let _e124 = (*index_2);
        if (_e124 < 4u) {
            let _e126 = (*index_2);
            if (_e126 < 2u) {
                let _e128 = (*index_2);
                if (_e128 < 1u) {
                    let _e132 = (*s_5).Reg[0i];
                    return _e132.xyz;
                } else {
                    let _e136 = (*s_5).Reg[0i];
                    return _e136.www;
                }
            } else {
                let _e138 = (*index_2);
                if (_e138 < 3u) {
                    let _e142 = (*s_5).Reg[1i];
                    return _e142.xyz;
                } else {
                    let _e146 = (*s_5).Reg[1i];
                    return _e146.www;
                }
            }
        } else {
            let _e148 = (*index_2);
            if (_e148 < 6u) {
                let _e150 = (*index_2);
                if (_e150 < 5u) {
                    let _e154 = (*s_5).Reg[2i];
                    return _e154.xyz;
                } else {
                    let _e158 = (*s_5).Reg[2i];
                    return _e158.www;
                }
            } else {
                let _e160 = (*index_2);
                if (_e160 < 7u) {
                    let _e164 = (*s_5).Reg[3i];
                    return _e164.xyz;
                } else {
                    let _e168 = (*s_5).Reg[3i];
                    return _e168.www;
                }
            }
        }
    } else {
        let _e170 = (*index_2);
        if (_e170 < 12u) {
            let _e172 = (*index_2);
            if (_e172 < 10u) {
                let _e174 = (*index_2);
                if (_e174 < 9u) {
                    let _e177 = (*s_5).TexColor;
                    return _e177.xyz;
                } else {
                    let _e180 = (*s_5).TexColor;
                    return _e180.www;
                }
            } else {
                let _e182 = (*index_2);
                if (_e182 < 11u) {
                    let _e184 = (*s_5);
                    param_9 = _e184;
                    let _e185 = (*ss_3);
                    param_10 = _e185;
                    let _e186 = (*colors_0_3);
                    param_11 = _e186;
                    let _e187 = (*colors_1_3);
                    param_12 = _e187;
                    let _e188 = getRasColor_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b((&param_9), (&param_10), (&param_11), (&param_12));
                    return _e188.xyz;
                } else {
                    let _e190 = (*s_5);
                    param_13 = _e190;
                    let _e191 = (*ss_3);
                    param_14 = _e191;
                    let _e192 = (*colors_0_3);
                    param_15 = _e192;
                    let _e193 = (*colors_1_3);
                    param_16 = _e193;
                    let _e194 = getRasColor_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b((&param_13), (&param_14), (&param_15), (&param_16));
                    return _e194.www;
                }
            }
        } else {
            let _e196 = (*index_2);
            if (_e196 < 14u) {
                let _e198 = (*index_2);
                if (_e198 < 13u) {
                    return vec3<i32>(255i, 255i, 255i);
                } else {
                    return vec3<i32>(128i, 128i, 128i);
                }
            } else {
                let _e200 = (*index_2);
                if (_e200 < 15u) {
                    let _e202 = (*s_5);
                    param_17 = _e202;
                    let _e203 = (*ss_3);
                    param_18 = _e203;
                    let _e204 = getKonstColor_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b((&param_17), (&param_18));
                    return _e204.xyz;
                } else {
                    return vec3<i32>(0i, 0i, 0i);
                }
            }
        }
    }
}

fn Wrap_u0028_i1_u003b_u1_u003b(coord: ptr<function, i32>, mode: ptr<function, u32>) -> i32 {
    let _e109 = (*mode);
    if (_e109 == 0u) {
        let _e111 = (*coord);
        return _e111;
    } else {
        let _e112 = (*mode);
        if (_e112 < 6u) {
            let _e114 = (*coord);
            let _e115 = (*mode);
            return (_e114 & (65534i >> bitcast<u32>(_e115)));
        } else {
            return 0i;
        }
    }
}

fn idot_u0028_vi3_u003b_vi3_u003b(x_3: ptr<function, vec3<i32>>, y_1: ptr<function, vec3<i32>>) -> i32 {
    var tmp_1: vec3<i32>;

    let _e110 = (*x_3);
    let _e111 = (*y_1);
    tmp_1 = (_e110 * _e111);
    let _e114 = tmp_1[0u];
    let _e116 = tmp_1[1u];
    let _e119 = tmp_1[2u];
    return ((_e114 + _e116) + _e119);
}

fn sampleTexture_7_u0028_vi2_u003b_i1_u003b(uv: ptr<function, vec2<i32>>, layer: ptr<function, i32>) -> vec4<i32> {
    var size_s: f32;
    var size_t: f32;
    var coords: vec3<f32>;
    var texmode0_: u32;
    var lod_bias: f32;
    var param_19: vec4<f32>;

    let _e118 = unnamed.texdim[7i][0u];
    size_s = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[7i][1u];
    size_t = f32((_e124 * 128i));
    let _e128 = (*uv)[0u];
    let _e130 = size_s;
    let _e133 = (*uv)[1u];
    let _e135 = size_t;
    let _e137 = (*layer);
    coords = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[7i][2u];
    texmode0_ = _e143;
    let _e144 = texmode0_;
    lod_bias = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords;
    let _e152 = lod_bias;
    let _e158 = textureSampleBias(samp_tex7_, samp_smp7_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_19 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_19));
    return _e160;
}

fn sampleTexture_6_u0028_vi2_u003b_i1_u003b(uv_1: ptr<function, vec2<i32>>, layer_1: ptr<function, i32>) -> vec4<i32> {
    var size_s_1: f32;
    var size_t_1: f32;
    var coords_1: vec3<f32>;
    var texmode0_1: u32;
    var lod_bias_1: f32;
    var param_20: vec4<f32>;

    let _e118 = unnamed.texdim[6i][0u];
    size_s_1 = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[6i][1u];
    size_t_1 = f32((_e124 * 128i));
    let _e128 = (*uv_1)[0u];
    let _e130 = size_s_1;
    let _e133 = (*uv_1)[1u];
    let _e135 = size_t_1;
    let _e137 = (*layer_1);
    coords_1 = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[6i][2u];
    texmode0_1 = _e143;
    let _e144 = texmode0_1;
    lod_bias_1 = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords_1;
    let _e152 = lod_bias_1;
    let _e158 = textureSampleBias(samp_tex6_, samp_smp6_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_20 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_20));
    return _e160;
}

fn sampleTexture_5_u0028_vi2_u003b_i1_u003b(uv_2: ptr<function, vec2<i32>>, layer_2: ptr<function, i32>) -> vec4<i32> {
    var size_s_2: f32;
    var size_t_2: f32;
    var coords_2: vec3<f32>;
    var texmode0_2: u32;
    var lod_bias_2: f32;
    var param_21: vec4<f32>;

    let _e118 = unnamed.texdim[5i][0u];
    size_s_2 = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[5i][1u];
    size_t_2 = f32((_e124 * 128i));
    let _e128 = (*uv_2)[0u];
    let _e130 = size_s_2;
    let _e133 = (*uv_2)[1u];
    let _e135 = size_t_2;
    let _e137 = (*layer_2);
    coords_2 = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[5i][2u];
    texmode0_2 = _e143;
    let _e144 = texmode0_2;
    lod_bias_2 = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords_2;
    let _e152 = lod_bias_2;
    let _e158 = textureSampleBias(samp_tex5_, samp_smp5_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_21 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_21));
    return _e160;
}

fn sampleTexture_4_u0028_vi2_u003b_i1_u003b(uv_3: ptr<function, vec2<i32>>, layer_3: ptr<function, i32>) -> vec4<i32> {
    var size_s_3: f32;
    var size_t_3: f32;
    var coords_3: vec3<f32>;
    var texmode0_3: u32;
    var lod_bias_3: f32;
    var param_22: vec4<f32>;

    let _e118 = unnamed.texdim[4i][0u];
    size_s_3 = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[4i][1u];
    size_t_3 = f32((_e124 * 128i));
    let _e128 = (*uv_3)[0u];
    let _e130 = size_s_3;
    let _e133 = (*uv_3)[1u];
    let _e135 = size_t_3;
    let _e137 = (*layer_3);
    coords_3 = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[4i][2u];
    texmode0_3 = _e143;
    let _e144 = texmode0_3;
    lod_bias_3 = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords_3;
    let _e152 = lod_bias_3;
    let _e158 = textureSampleBias(samp_tex4_, samp_smp4_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_22 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_22));
    return _e160;
}

fn sampleTexture_3_u0028_vi2_u003b_i1_u003b(uv_4: ptr<function, vec2<i32>>, layer_4: ptr<function, i32>) -> vec4<i32> {
    var size_s_4: f32;
    var size_t_4: f32;
    var coords_4: vec3<f32>;
    var texmode0_4: u32;
    var lod_bias_4: f32;
    var param_23: vec4<f32>;

    let _e118 = unnamed.texdim[3i][0u];
    size_s_4 = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[3i][1u];
    size_t_4 = f32((_e124 * 128i));
    let _e128 = (*uv_4)[0u];
    let _e130 = size_s_4;
    let _e133 = (*uv_4)[1u];
    let _e135 = size_t_4;
    let _e137 = (*layer_4);
    coords_4 = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[3i][2u];
    texmode0_4 = _e143;
    let _e144 = texmode0_4;
    lod_bias_4 = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords_4;
    let _e152 = lod_bias_4;
    let _e158 = textureSampleBias(samp_tex3_, samp_smp3_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_23 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_23));
    return _e160;
}

fn sampleTexture_2_u0028_vi2_u003b_i1_u003b(uv_5: ptr<function, vec2<i32>>, layer_5: ptr<function, i32>) -> vec4<i32> {
    var size_s_5: f32;
    var size_t_5: f32;
    var coords_5: vec3<f32>;
    var texmode0_5: u32;
    var lod_bias_5: f32;
    var param_24: vec4<f32>;

    let _e118 = unnamed.texdim[2i][0u];
    size_s_5 = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[2i][1u];
    size_t_5 = f32((_e124 * 128i));
    let _e128 = (*uv_5)[0u];
    let _e130 = size_s_5;
    let _e133 = (*uv_5)[1u];
    let _e135 = size_t_5;
    let _e137 = (*layer_5);
    coords_5 = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[2i][2u];
    texmode0_5 = _e143;
    let _e144 = texmode0_5;
    lod_bias_5 = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords_5;
    let _e152 = lod_bias_5;
    let _e158 = textureSampleBias(samp_tex2_, samp_smp2_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_24 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_24));
    return _e160;
}

fn sampleTexture_1_u0028_vi2_u003b_i1_u003b(uv_6: ptr<function, vec2<i32>>, layer_6: ptr<function, i32>) -> vec4<i32> {
    var size_s_6: f32;
    var size_t_6: f32;
    var coords_6: vec3<f32>;
    var texmode0_6: u32;
    var lod_bias_6: f32;
    var param_25: vec4<f32>;

    let _e118 = unnamed.texdim[1i][0u];
    size_s_6 = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[1i][1u];
    size_t_6 = f32((_e124 * 128i));
    let _e128 = (*uv_6)[0u];
    let _e130 = size_s_6;
    let _e133 = (*uv_6)[1u];
    let _e135 = size_t_6;
    let _e137 = (*layer_6);
    coords_6 = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[1i][2u];
    texmode0_6 = _e143;
    let _e144 = texmode0_6;
    lod_bias_6 = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords_6;
    let _e152 = lod_bias_6;
    let _e158 = textureSampleBias(samp_tex1_, samp_smp1_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_25 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_25));
    return _e160;
}

fn sampleTexture_0_u0028_vi2_u003b_i1_u003b(uv_7: ptr<function, vec2<i32>>, layer_7: ptr<function, i32>) -> vec4<i32> {
    var size_s_7: f32;
    var size_t_7: f32;
    var coords_7: vec3<f32>;
    var texmode0_7: u32;
    var lod_bias_7: f32;
    var param_26: vec4<f32>;

    let _e118 = unnamed.texdim[0i][0u];
    size_s_7 = f32((_e118 * 128i));
    let _e124 = unnamed.texdim[0i][1u];
    size_t_7 = f32((_e124 * 128i));
    let _e128 = (*uv_7)[0u];
    let _e130 = size_s_7;
    let _e133 = (*uv_7)[1u];
    let _e135 = size_t_7;
    let _e137 = (*layer_7);
    coords_7 = vec3<f32>((f32(_e128) / _e130), (f32(_e133) / _e135), f32(_e137));
    let _e143 = unnamed.bpmem_pack2_[0i][2u];
    texmode0_7 = _e143;
    let _e144 = texmode0_7;
    lod_bias_7 = (f32(extractBits(bitcast<i32>(_e144), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
    let _e151 = coords_7;
    let _e152 = lod_bias_7;
    let _e158 = textureSampleBias(samp_tex0_, samp_smp0_, vec2<f32>(_e151.x, _e151.y), i32(_e151.z), _e152);
    param_26 = (_e158 * 255f);
    let _e160 = iround_u0028_vf4_u003b((&param_26));
    return _e160;
}

fn sampleTextureWrapper_u0028_u1_u003b_vi2_u003b_i1_u003b(sampler_num: ptr<function, u32>, uv_8: ptr<function, vec2<i32>>, layer_8: ptr<function, i32>) -> vec4<i32> {
    var param_27: vec2<i32>;
    var param_28: i32;
    var param_29: vec2<i32>;
    var param_30: i32;
    var param_31: vec2<i32>;
    var param_32: i32;
    var param_33: vec2<i32>;
    var param_34: i32;
    var param_35: vec2<i32>;
    var param_36: i32;
    var param_37: vec2<i32>;
    var param_38: i32;
    var param_39: vec2<i32>;
    var param_40: i32;
    var param_41: vec2<i32>;
    var param_42: i32;

    let _e126 = (*sampler_num);
    if (_e126 == 0u) {
        let _e128 = (*uv_8);
        param_27 = _e128;
        let _e129 = (*layer_8);
        param_28 = _e129;
        let _e130 = sampleTexture_0_u0028_vi2_u003b_i1_u003b((&param_27), (&param_28));
        return _e130;
    } else {
        let _e131 = (*sampler_num);
        if (_e131 == 1u) {
            let _e133 = (*uv_8);
            param_29 = _e133;
            let _e134 = (*layer_8);
            param_30 = _e134;
            let _e135 = sampleTexture_1_u0028_vi2_u003b_i1_u003b((&param_29), (&param_30));
            return _e135;
        } else {
            let _e136 = (*sampler_num);
            if (_e136 == 2u) {
                let _e138 = (*uv_8);
                param_31 = _e138;
                let _e139 = (*layer_8);
                param_32 = _e139;
                let _e140 = sampleTexture_2_u0028_vi2_u003b_i1_u003b((&param_31), (&param_32));
                return _e140;
            } else {
                let _e141 = (*sampler_num);
                if (_e141 == 3u) {
                    let _e143 = (*uv_8);
                    param_33 = _e143;
                    let _e144 = (*layer_8);
                    param_34 = _e144;
                    let _e145 = sampleTexture_3_u0028_vi2_u003b_i1_u003b((&param_33), (&param_34));
                    return _e145;
                } else {
                    let _e146 = (*sampler_num);
                    if (_e146 == 4u) {
                        let _e148 = (*uv_8);
                        param_35 = _e148;
                        let _e149 = (*layer_8);
                        param_36 = _e149;
                        let _e150 = sampleTexture_4_u0028_vi2_u003b_i1_u003b((&param_35), (&param_36));
                        return _e150;
                    } else {
                        let _e151 = (*sampler_num);
                        if (_e151 == 5u) {
                            let _e153 = (*uv_8);
                            param_37 = _e153;
                            let _e154 = (*layer_8);
                            param_38 = _e154;
                            let _e155 = sampleTexture_5_u0028_vi2_u003b_i1_u003b((&param_37), (&param_38));
                            return _e155;
                        } else {
                            let _e156 = (*sampler_num);
                            if (_e156 == 6u) {
                                let _e158 = (*uv_8);
                                param_39 = _e158;
                                let _e159 = (*layer_8);
                                param_40 = _e159;
                                let _e160 = sampleTexture_6_u0028_vi2_u003b_i1_u003b((&param_39), (&param_40));
                                return _e160;
                            } else {
                                let _e161 = (*uv_8);
                                param_41 = _e161;
                                let _e162 = (*layer_8);
                                param_42 = _e162;
                                let _e163 = sampleTexture_7_u0028_vi2_u003b_i1_u003b((&param_41), (&param_42));
                                return _e163;
                            }
                        }
                    }
                }
            }
        }
    }
}

fn selectTexCoord_u0028_u1_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b(index_3: ptr<function, u32>, fixpoint_uv0_: ptr<function, vec2<i32>>, fixpoint_uv1_: ptr<function, vec2<i32>>, fixpoint_uv2_: ptr<function, vec2<i32>>, fixpoint_uv3_: ptr<function, vec2<i32>>, fixpoint_uv4_: ptr<function, vec2<i32>>, fixpoint_uv5_: ptr<function, vec2<i32>>, fixpoint_uv6_: ptr<function, vec2<i32>>, fixpoint_uv7_: ptr<function, vec2<i32>>) -> vec2<i32> {
    let _e116 = (*index_3);
    if (_e116 >= 8u) {
        let _e118 = (*fixpoint_uv0_);
        return _e118;
    }
    let _e119 = (*index_3);
    if (_e119 < 4u) {
        let _e121 = (*index_3);
        if (_e121 < 2u) {
            let _e123 = (*index_3);
            let _e125 = (*fixpoint_uv0_);
            let _e126 = (*fixpoint_uv1_);
            return select(_e126, _e125, vec2((_e123 == 0u)));
        } else {
            let _e129 = (*index_3);
            let _e131 = (*fixpoint_uv2_);
            let _e132 = (*fixpoint_uv3_);
            return select(_e132, _e131, vec2((_e129 == 2u)));
        }
    } else {
        let _e135 = (*index_3);
        if (_e135 < 6u) {
            let _e137 = (*index_3);
            let _e139 = (*fixpoint_uv4_);
            let _e140 = (*fixpoint_uv5_);
            return select(_e140, _e139, vec2((_e137 == 4u)));
        } else {
            let _e143 = (*index_3);
            let _e145 = (*fixpoint_uv6_);
            let _e146 = (*fixpoint_uv7_);
            return select(_e146, _e145, vec2((_e143 == 6u)));
        }
    }
}

fn main_1() {
    var rawpos: vec4<f32>;
    var num_stages: u32;
    var layer_9: i32;
    var tevcoord: vec3<i32>;
    var s_6: State;
    var stage: u32;
    var ss_4: StageState;
    var fixpoint_uv0_1: vec2<i32>;
    var local: vec2<f32>;
    var fixpoint_uv1_1: vec2<i32>;
    var local_1: vec2<f32>;
    var fixpoint_uv2_1: vec2<i32>;
    var local_2: vec2<f32>;
    var fixpoint_uv3_1: vec2<i32>;
    var local_3: vec2<f32>;
    var fixpoint_uv4_1: vec2<i32>;
    var local_4: vec2<f32>;
    var fixpoint_uv5_1: vec2<i32>;
    var local_5: vec2<f32>;
    var fixpoint_uv6_1: vec2<i32>;
    var local_6: vec2<f32>;
    var fixpoint_uv7_1: vec2<i32>;
    var local_7: vec2<f32>;
    var tex_coord: u32;
    var fixedPoint_uv: vec2<i32>;
    var param_43: u32;
    var param_44: vec2<i32>;
    var param_45: vec2<i32>;
    var param_46: vec2<i32>;
    var param_47: vec2<i32>;
    var param_48: vec2<i32>;
    var param_49: vec2<i32>;
    var param_50: vec2<i32>;
    var param_51: vec2<i32>;
    var texture_enabled: bool;
    var tevind: u32;
    var bs: u32;
    var fmt: u32;
    var bias_2: u32;
    var bt: u32;
    var matrix_index: u32;
    var matrix_id: u32;
    var indtevtrans: vec2<i32>;
    var iref: u32;
    var texcoord: u32;
    var texmap: u32;
    var fixedPoint_uv_1: vec2<i32>;
    var param_52: u32;
    var param_53: vec2<i32>;
    var param_54: vec2<i32>;
    var param_55: vec2<i32>;
    var param_56: vec2<i32>;
    var param_57: vec2<i32>;
    var param_58: vec2<i32>;
    var param_59: vec2<i32>;
    var param_60: vec2<i32>;
    var indcoord: vec3<i32>;
    var param_61: u32;
    var param_62: vec2<i32>;
    var param_63: i32;
    var mtxidx: u32;
    var shift: i32;
    var param_64: vec3<i32>;
    var param_65: vec3<i32>;
    var param_66: vec3<i32>;
    var param_67: vec3<i32>;
    var sw: u32;
    var tw: u32;
    var wrapped_coord: vec2<i32>;
    var param_68: i32;
    var param_69: u32;
    var param_70: i32;
    var param_71: u32;
    var sampler_num_1: u32;
    var param_72: u32;
    var param_73: vec2<i32>;
    var param_74: i32;
    var swap_1: u32;
    var param_75: u32;
    var param_76: vec4<i32>;
    var color_a: u32;
    var color_b: u32;
    var color_c: u32;
    var color_d: u32;
    var color_bias: u32;
    var color_op: bool;
    var color_clamp: bool;
    var color_scale: u32;
    var color_dest: u32;
    var color_compare_op: u32;
    var color_A_1: vec3<i32>;
    var param_77: State;
    var param_78: StageState;
    var param_79: vec4<f32>;
    var param_80: vec4<f32>;
    var param_81: u32;
    var color_B_1: vec3<i32>;
    var param_82: State;
    var param_83: StageState;
    var param_84: vec4<f32>;
    var param_85: vec4<f32>;
    var param_86: u32;
    var color_C: vec3<i32>;
    var param_87: State;
    var param_88: StageState;
    var param_89: vec4<f32>;
    var param_90: vec4<f32>;
    var param_91: u32;
    var color_D: vec3<i32>;
    var param_92: State;
    var param_93: StageState;
    var param_94: vec4<f32>;
    var param_95: vec4<f32>;
    var param_96: u32;
    var color_2: vec3<i32>;
    var param_97: vec3<i32>;
    var param_98: vec3<i32>;
    var param_99: vec3<i32>;
    var param_100: vec3<i32>;
    var param_101: u32;
    var param_102: bool;
    var param_103: u32;
    var local_8: i32;
    var local_9: i32;
    var local_10: i32;
    var local_11: i32;
    var local_12: i32;
    var local_13: i32;
    var param_104: u32;
    var param_105: vec3<i32>;
    var param_106: vec3<i32>;
    var alpha_a: u32;
    var alpha_b: u32;
    var alpha_c: u32;
    var alpha_d: u32;
    var alpha_bias: u32;
    var alpha_op: bool;
    var alpha_clamp: bool;
    var alpha_scale: u32;
    var alpha_dest: u32;
    var alpha_compare_op: u32;
    var alpha_A: i32;
    var alpha_B: i32;
    var param_107: State;
    var param_108: StageState;
    var param_109: vec4<f32>;
    var param_110: vec4<f32>;
    var param_111: u32;
    var param_112: State;
    var param_113: StageState;
    var param_114: vec4<f32>;
    var param_115: vec4<f32>;
    var param_116: u32;
    var alpha_C: i32;
    var param_117: State;
    var param_118: StageState;
    var param_119: vec4<f32>;
    var param_120: vec4<f32>;
    var param_121: u32;
    var alpha_D: i32;
    var param_122: State;
    var param_123: StageState;
    var param_124: vec4<f32>;
    var param_125: vec4<f32>;
    var param_126: u32;
    var alpha: i32;
    var param_127: i32;
    var param_128: i32;
    var param_129: i32;
    var param_130: i32;
    var param_131: u32;
    var param_132: bool;
    var param_133: u32;
    var param_134: u32;
    var param_135: vec3<i32>;
    var param_136: vec3<i32>;
    var TevResult: vec4<i32>;
    var param_137: State;
    var param_138: u32;
    var param_139: State;
    var param_140: u32;
    var zCoord: i32;
    var early_zCoord: i32;
    var ztex: i32;
    var param_141: vec4<i32>;
    var param_142: vec4<i32>;
    var comp0_: bool;
    var param_143: i32;
    var param_144: i32;
    var param_145: u32;
    var comp1_: bool;
    var param_146: i32;
    var param_147: i32;
    var param_148: u32;
    var alpha_op_1: u32;
    var alpha_pass: bool;
    var dither: vec2<i32>;
    var fog_function: u32;
    var ze: f32;
    var offset: f32;
    var floatindex: f32;
    var indexlower: u32;
    var indexupper: u32;
    var klower: f32;
    var kupper: f32;
    var k: f32;
    var x_adjust: f32;
    var fog: f32;
    var ifog: i32;
    var param_149: f32;

    let _e317 = gl_FragCoord_1;
    rawpos = _e317;
    let _e319 = unnamed.bpmem_genmode;
    num_stages = extractBits(_e319, bitcast<u32>(10i), bitcast<u32>(4i));
    layer_9 = 0i;
    tevcoord = vec3<i32>(0i, 0i, 0i);
    s_6.TexColor = vec4<i32>(0i, 0i, 0i, 0i);
    s_6.RawTexColor = vec4<i32>(0i, 0i, 0i, 0i);
    s_6.AlphaBump = 0i;
    let _e328 = unnamed.color[0i];
    s_6.Reg[0i] = _e328;
    let _e333 = unnamed.color[1i];
    s_6.Reg[1i] = _e333;
    let _e338 = unnamed.color[2i];
    s_6.Reg[2i] = _e338;
    let _e343 = unnamed.color[3i];
    s_6.Reg[3i] = _e343;
    stage = 0u;
    loop {
        let _e346 = stage;
        let _e347 = num_stages;
        if (_e346 <= _e347) {
            let _e349 = stage;
            ss_4.stage = _e349;
            let _e351 = stage;
            let _e355 = unnamed.bpmem_pack1_[_e351][0u];
            ss_4.cc = _e355;
            let _e357 = stage;
            let _e361 = unnamed.bpmem_pack1_[_e357][1u];
            ss_4.ac = _e361;
            let _e363 = stage;
            let _e369 = unnamed.bpmem_pack2_[(_e363 >> bitcast<u32>(1i))][0u];
            ss_4.order = _e369;
            let _e371 = stage;
            if ((_e371 & 1u) == 1u) {
                let _e375 = ss_4.order;
                ss_4.order = (_e375 >> bitcast<u32>(12i));
            }
            let _e380 = tex0_1[2u];
            if (_e380 == 0f) {
                let _e382 = tex0_1;
                local = _e382.xy;
            } else {
                let _e384 = tex0_1;
                let _e387 = tex0_1[2u];
                local = (_e384.xy / vec2(_e387));
            }
            let _e390 = local;
            let _e393 = unnamed.texdim[0i];
            fixpoint_uv0_1 = vec2<i32>((_e390 * vec2<f32>((_e393.zw * vec2(128i)))));
            let _e401 = tex1_1[2u];
            if (_e401 == 0f) {
                let _e403 = tex1_1;
                local_1 = _e403.xy;
            } else {
                let _e405 = tex1_1;
                let _e408 = tex1_1[2u];
                local_1 = (_e405.xy / vec2(_e408));
            }
            let _e411 = local_1;
            let _e414 = unnamed.texdim[1i];
            fixpoint_uv1_1 = vec2<i32>((_e411 * vec2<f32>((_e414.zw * vec2(128i)))));
            let _e422 = tex2_1[2u];
            if (_e422 == 0f) {
                let _e424 = tex2_1;
                local_2 = _e424.xy;
            } else {
                let _e426 = tex2_1;
                let _e429 = tex2_1[2u];
                local_2 = (_e426.xy / vec2(_e429));
            }
            let _e432 = local_2;
            let _e435 = unnamed.texdim[2i];
            fixpoint_uv2_1 = vec2<i32>((_e432 * vec2<f32>((_e435.zw * vec2(128i)))));
            let _e443 = tex3_1[2u];
            if (_e443 == 0f) {
                let _e445 = tex3_1;
                local_3 = _e445.xy;
            } else {
                let _e447 = tex3_1;
                let _e450 = tex3_1[2u];
                local_3 = (_e447.xy / vec2(_e450));
            }
            let _e453 = local_3;
            let _e456 = unnamed.texdim[3i];
            fixpoint_uv3_1 = vec2<i32>((_e453 * vec2<f32>((_e456.zw * vec2(128i)))));
            let _e464 = tex4_1[2u];
            if (_e464 == 0f) {
                let _e466 = tex4_1;
                local_4 = _e466.xy;
            } else {
                let _e468 = tex4_1;
                let _e471 = tex4_1[2u];
                local_4 = (_e468.xy / vec2(_e471));
            }
            let _e474 = local_4;
            let _e477 = unnamed.texdim[4i];
            fixpoint_uv4_1 = vec2<i32>((_e474 * vec2<f32>((_e477.zw * vec2(128i)))));
            let _e485 = tex5_1[2u];
            if (_e485 == 0f) {
                let _e487 = tex5_1;
                local_5 = _e487.xy;
            } else {
                let _e489 = tex5_1;
                let _e492 = tex5_1[2u];
                local_5 = (_e489.xy / vec2(_e492));
            }
            let _e495 = local_5;
            let _e498 = unnamed.texdim[5i];
            fixpoint_uv5_1 = vec2<i32>((_e495 * vec2<f32>((_e498.zw * vec2(128i)))));
            let _e506 = tex6_1[2u];
            if (_e506 == 0f) {
                let _e508 = tex6_1;
                local_6 = _e508.xy;
            } else {
                let _e510 = tex6_1;
                let _e513 = tex6_1[2u];
                local_6 = (_e510.xy / vec2(_e513));
            }
            let _e516 = local_6;
            let _e519 = unnamed.texdim[6i];
            fixpoint_uv6_1 = vec2<i32>((_e516 * vec2<f32>((_e519.zw * vec2(128i)))));
            let _e527 = tex7_1[2u];
            if (_e527 == 0f) {
                let _e529 = tex7_1;
                local_7 = _e529.xy;
            } else {
                let _e531 = tex7_1;
                let _e534 = tex7_1[2u];
                local_7 = (_e531.xy / vec2(_e534));
            }
            let _e537 = local_7;
            let _e540 = unnamed.texdim[7i];
            fixpoint_uv7_1 = vec2<i32>((_e537 * vec2<f32>((_e540.zw * vec2(128i)))));
            let _e548 = ss_4.order;
            tex_coord = extractBits(_e548, bitcast<u32>(3i), bitcast<u32>(3i));
            let _e552 = tex_coord;
            param_43 = _e552;
            let _e553 = fixpoint_uv0_1;
            param_44 = _e553;
            let _e554 = fixpoint_uv1_1;
            param_45 = _e554;
            let _e555 = fixpoint_uv2_1;
            param_46 = _e555;
            let _e556 = fixpoint_uv3_1;
            param_47 = _e556;
            let _e557 = fixpoint_uv4_1;
            param_48 = _e557;
            let _e558 = fixpoint_uv5_1;
            param_49 = _e558;
            let _e559 = fixpoint_uv6_1;
            param_50 = _e559;
            let _e560 = fixpoint_uv7_1;
            param_51 = _e560;
            let _e561 = selectTexCoord_u0028_u1_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b((&param_43), (&param_44), (&param_45), (&param_46), (&param_47), (&param_48), (&param_49), (&param_50), (&param_51));
            fixedPoint_uv = _e561;
            let _e563 = ss_4.order;
            texture_enabled = ((_e563 & 64u) != 0u);
            let _e566 = stage;
            let _e570 = unnamed.bpmem_pack1_[_e566][2u];
            tevind = _e570;
            let _e571 = tevind;
            if (_e571 != 0u) {
                let _e573 = tevind;
                bs = extractBits(_e573, bitcast<u32>(7i), bitcast<u32>(2i));
                let _e577 = tevind;
                fmt = extractBits(_e577, bitcast<u32>(2i), bitcast<u32>(2i));
                let _e581 = tevind;
                bias_2 = extractBits(_e581, bitcast<u32>(4i), bitcast<u32>(3i));
                let _e585 = tevind;
                bt = extractBits(_e585, bitcast<u32>(0i), bitcast<u32>(2i));
                let _e589 = tevind;
                matrix_index = extractBits(_e589, bitcast<u32>(9i), bitcast<u32>(2i));
                let _e593 = tevind;
                matrix_id = extractBits(_e593, bitcast<u32>(11i), bitcast<u32>(2i));
                indtevtrans = vec2<i32>(0i, 0i);
                let _e597 = bt;
                let _e601 = unnamed.bpmem_pack1_[_e597][3u];
                if (_e601 != 0u) {
                    let _e603 = bt;
                    let _e607 = unnamed.bpmem_pack1_[_e603][3u];
                    iref = _e607;
                    let _e608 = iref;
                    texcoord = extractBits(_e608, bitcast<u32>(0i), bitcast<u32>(3i));
                    let _e612 = iref;
                    texmap = extractBits(_e612, bitcast<u32>(8i), bitcast<u32>(3i));
                    let _e616 = texcoord;
                    param_52 = _e616;
                    let _e617 = fixpoint_uv0_1;
                    param_53 = _e617;
                    let _e618 = fixpoint_uv1_1;
                    param_54 = _e618;
                    let _e619 = fixpoint_uv2_1;
                    param_55 = _e619;
                    let _e620 = fixpoint_uv3_1;
                    param_56 = _e620;
                    let _e621 = fixpoint_uv4_1;
                    param_57 = _e621;
                    let _e622 = fixpoint_uv5_1;
                    param_58 = _e622;
                    let _e623 = fixpoint_uv6_1;
                    param_59 = _e623;
                    let _e624 = fixpoint_uv7_1;
                    param_60 = _e624;
                    let _e625 = selectTexCoord_u0028_u1_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b_vi2_u003b((&param_52), (&param_53), (&param_54), (&param_55), (&param_56), (&param_57), (&param_58), (&param_59), (&param_60));
                    fixedPoint_uv_1 = _e625;
                    let _e626 = bt;
                    if ((_e626 & 1u) == 0u) {
                        let _e629 = fixedPoint_uv_1;
                        let _e630 = bt;
                        let _e635 = unnamed.cindscale[(_e630 >> bitcast<u32>(1i))];
                        fixedPoint_uv_1 = (_e629 >> bitcast<vec2<u32>>(_e635.xy));
                    } else {
                        let _e639 = fixedPoint_uv_1;
                        let _e640 = bt;
                        let _e645 = unnamed.cindscale[(_e640 >> bitcast<u32>(1i))];
                        fixedPoint_uv_1 = (_e639 >> bitcast<vec2<u32>>(_e645.zw));
                    }
                    let _e649 = texmap;
                    param_61 = _e649;
                    let _e650 = fixedPoint_uv_1;
                    param_62 = _e650;
                    let _e651 = layer_9;
                    param_63 = _e651;
                    let _e652 = sampleTextureWrapper_u0028_u1_u003b_vi2_u003b_i1_u003b((&param_61), (&param_62), (&param_63));
                    indcoord = _e652.wzy;
                    let _e654 = bs;
                    if (_e654 != 0u) {
                        let _e656 = bs;
                        let _e659 = indcoord[(_e656 - 1u)];
                        s_6.AlphaBump = _e659;
                    }
                    let _e661 = fmt;
                    switch bitcast<i32>(_e661) {
                        case 0: {
                            let _e664 = indcoord[0u];
                            let _e665 = bias_2;
                            indcoord[0u] = (_e664 + select(0i, -128i, ((_e665 & 1u) != 0u)));
                            let _e672 = indcoord[1u];
                            let _e673 = bias_2;
                            indcoord[1u] = (_e672 + select(0i, -128i, ((_e673 & 2u) != 0u)));
                            let _e680 = indcoord[2u];
                            let _e681 = bias_2;
                            indcoord[2u] = (_e680 + select(0i, -128i, ((_e681 & 4u) != 0u)));
                            let _e688 = s_6.AlphaBump;
                            s_6.AlphaBump = (_e688 & 248i);
                            break;
                        }
                        case 1: {
                            let _e692 = indcoord[0u];
                            let _e695 = bias_2;
                            indcoord[0u] = ((_e692 >> bitcast<u32>(3i)) + select(0i, 1i, ((_e695 & 1u) != 0u)));
                            let _e702 = indcoord[1u];
                            let _e705 = bias_2;
                            indcoord[1u] = ((_e702 >> bitcast<u32>(3i)) + select(0i, 1i, ((_e705 & 2u) != 0u)));
                            let _e712 = indcoord[2u];
                            let _e715 = bias_2;
                            indcoord[2u] = ((_e712 >> bitcast<u32>(3i)) + select(0i, 1i, ((_e715 & 4u) != 0u)));
                            let _e722 = s_6.AlphaBump;
                            s_6.AlphaBump = (_e722 << bitcast<u32>(5i));
                            break;
                        }
                        case 2: {
                            let _e727 = indcoord[0u];
                            let _e730 = bias_2;
                            indcoord[0u] = ((_e727 >> bitcast<u32>(4i)) + select(0i, 1i, ((_e730 & 1u) != 0u)));
                            let _e737 = indcoord[1u];
                            let _e740 = bias_2;
                            indcoord[1u] = ((_e737 >> bitcast<u32>(4i)) + select(0i, 1i, ((_e740 & 2u) != 0u)));
                            let _e747 = indcoord[2u];
                            let _e750 = bias_2;
                            indcoord[2u] = ((_e747 >> bitcast<u32>(4i)) + select(0i, 1i, ((_e750 & 4u) != 0u)));
                            let _e757 = s_6.AlphaBump;
                            s_6.AlphaBump = (_e757 << bitcast<u32>(4i));
                            break;
                        }
                        case 3: {
                            let _e762 = indcoord[0u];
                            let _e765 = bias_2;
                            indcoord[0u] = ((_e762 >> bitcast<u32>(5i)) + select(0i, 1i, ((_e765 & 1u) != 0u)));
                            let _e772 = indcoord[1u];
                            let _e775 = bias_2;
                            indcoord[1u] = ((_e772 >> bitcast<u32>(5i)) + select(0i, 1i, ((_e775 & 2u) != 0u)));
                            let _e782 = indcoord[2u];
                            let _e785 = bias_2;
                            indcoord[2u] = ((_e782 >> bitcast<u32>(5i)) + select(0i, 1i, ((_e785 & 4u) != 0u)));
                            let _e792 = s_6.AlphaBump;
                            s_6.AlphaBump = (_e792 << bitcast<u32>(3i));
                            break;
                        }
                        default: {
                        }
                    }
                    let _e796 = matrix_index;
                    if (_e796 != 0u) {
                        let _e798 = matrix_index;
                        mtxidx = (2u * (_e798 - 1u));
                        let _e801 = mtxidx;
                        let _e805 = unnamed.cindmtx[_e801][3u];
                        shift = _e805;
                        let _e806 = matrix_id;
                        switch bitcast<i32>(_e806) {
                            case 0: {
                                let _e808 = mtxidx;
                                let _e811 = unnamed.cindmtx[_e808];
                                param_64 = _e811.xyz;
                                let _e813 = indcoord;
                                param_65 = _e813;
                                let _e814 = idot_u0028_vi3_u003b_vi3_u003b((&param_64), (&param_65));
                                let _e815 = mtxidx;
                                let _e819 = unnamed.cindmtx[(_e815 + 1u)];
                                param_66 = _e819.xyz;
                                let _e821 = indcoord;
                                param_67 = _e821;
                                let _e822 = idot_u0028_vi3_u003b_vi3_u003b((&param_66), (&param_67));
                                indtevtrans = (vec2<i32>(_e814, _e822) >> bitcast<vec2<u32>>(vec2(3i)));
                                break;
                            }
                            case 1: {
                                let _e827 = fixedPoint_uv;
                                let _e828 = indcoord;
                                indtevtrans = ((_e827 * _e828.xx) >> bitcast<vec2<u32>>(vec2(8i)));
                                break;
                            }
                            case 2: {
                                let _e834 = fixedPoint_uv;
                                let _e835 = indcoord;
                                indtevtrans = ((_e834 * _e835.yy) >> bitcast<vec2<u32>>(vec2(8i)));
                                break;
                            }
                            default: {
                            }
                        }
                        let _e841 = shift;
                        if (_e841 >= 0i) {
                            let _e843 = indtevtrans;
                            let _e844 = shift;
                            indtevtrans = (_e843 >> bitcast<vec2<u32>>(vec2(_e844)));
                        } else {
                            let _e848 = indtevtrans;
                            let _e849 = shift;
                            indtevtrans = (_e848 << bitcast<vec2<u32>>(vec2((-(_e849) & 31i))));
                        }
                    }
                }
                let _e855 = tevind;
                sw = extractBits(_e855, bitcast<u32>(13i), bitcast<u32>(3i));
                let _e859 = tevind;
                tw = extractBits(_e859, bitcast<u32>(16i), bitcast<u32>(3i));
                let _e864 = fixedPoint_uv[0u];
                param_68 = _e864;
                let _e865 = sw;
                param_69 = _e865;
                let _e866 = Wrap_u0028_i1_u003b_u1_u003b((&param_68), (&param_69));
                let _e868 = fixedPoint_uv[1u];
                param_70 = _e868;
                let _e869 = tw;
                param_71 = _e869;
                let _e870 = Wrap_u0028_i1_u003b_u1_u003b((&param_70), (&param_71));
                wrapped_coord = vec2<i32>(_e866, _e870);
                let _e872 = tevind;
                if ((_e872 & 1048576u) != 0u) {
                    let _e875 = wrapped_coord;
                    let _e876 = indtevtrans;
                    let _e878 = tevcoord;
                    let _e880 = (_e878.xy + (_e875 + _e876));
                    let _e881 = tevcoord;
                    tevcoord = vec3<i32>(_e880.x, _e880.y, _e881.z);
                } else {
                    let _e886 = wrapped_coord;
                    let _e887 = indtevtrans;
                    let _e888 = (_e886 + _e887);
                    let _e889 = tevcoord;
                    tevcoord = vec3<i32>(_e888.x, _e888.y, _e889.z);
                }
                let _e894 = tevcoord;
                let _e901 = ((_e894.xy << bitcast<vec2<u32>>(vec2(8i))) >> bitcast<vec2<u32>>(vec2(8i)));
                let _e902 = tevcoord;
                tevcoord = vec3<i32>(_e901.x, _e901.y, _e902.z);
            } else {
                let _e907 = fixedPoint_uv;
                let _e908 = tevcoord;
                tevcoord = vec3<i32>(_e907.x, _e907.y, _e908.z);
            }
            let _e913 = texture_enabled;
            if _e913 {
                let _e915 = ss_4.order;
                sampler_num_1 = extractBits(_e915, bitcast<u32>(0i), bitcast<u32>(3i));
                let _e919 = sampler_num_1;
                param_72 = _e919;
                let _e920 = tevcoord;
                param_73 = _e920.xy;
                let _e922 = layer_9;
                param_74 = _e922;
                let _e923 = sampleTextureWrapper_u0028_u1_u003b_vi2_u003b_i1_u003b((&param_72), (&param_73), (&param_74));
                s_6.RawTexColor = _e923;
                let _e926 = ss_4.ac;
                swap_1 = extractBits(_e926, bitcast<u32>(2i), bitcast<u32>(2i));
                let _e930 = swap_1;
                param_75 = _e930;
                let _e932 = s_6.RawTexColor;
                param_76 = _e932;
                let _e933 = Swizzle_u0028_u1_u003b_vi4_u003b((&param_75), (&param_76));
                s_6.TexColor = _e933;
            } else {
                s_6.TexColor = vec4<i32>(255i, 255i, 255i, 255i);
            }
            let _e937 = ss_4.cc;
            color_a = extractBits(_e937, bitcast<u32>(12i), bitcast<u32>(4i));
            let _e942 = ss_4.cc;
            color_b = extractBits(_e942, bitcast<u32>(8i), bitcast<u32>(4i));
            let _e947 = ss_4.cc;
            color_c = extractBits(_e947, bitcast<u32>(4i), bitcast<u32>(4i));
            let _e952 = ss_4.cc;
            color_d = extractBits(_e952, bitcast<u32>(0i), bitcast<u32>(4i));
            let _e957 = ss_4.cc;
            color_bias = extractBits(_e957, bitcast<u32>(16i), bitcast<u32>(2i));
            let _e962 = ss_4.cc;
            color_op = (extractBits(_e962, bitcast<u32>(18i), bitcast<u32>(1i)) != 0u);
            let _e968 = ss_4.cc;
            color_clamp = (extractBits(_e968, bitcast<u32>(19i), bitcast<u32>(1i)) != 0u);
            let _e974 = ss_4.cc;
            color_scale = extractBits(_e974, bitcast<u32>(20i), bitcast<u32>(2i));
            let _e979 = ss_4.cc;
            color_dest = extractBits(_e979, bitcast<u32>(22i), bitcast<u32>(2i));
            let _e983 = color_scale;
            let _e986 = color_op;
            color_compare_op = ((_e983 << bitcast<u32>(1i)) | select(0u, 1u, _e986));
            let _e989 = s_6;
            param_77 = _e989;
            let _e990 = ss_4;
            param_78 = _e990;
            let _e991 = colors_0_4;
            param_79 = _e991;
            let _e992 = colors_1_4;
            param_80 = _e992;
            let _e993 = color_a;
            param_81 = _e993;
            let _e994 = selectColorInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_77), (&param_78), (&param_79), (&param_80), (&param_81));
            color_A_1 = (_e994 & vec3<i32>(255i, 255i, 255i));
            let _e996 = s_6;
            param_82 = _e996;
            let _e997 = ss_4;
            param_83 = _e997;
            let _e998 = colors_0_4;
            param_84 = _e998;
            let _e999 = colors_1_4;
            param_85 = _e999;
            let _e1000 = color_b;
            param_86 = _e1000;
            let _e1001 = selectColorInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_82), (&param_83), (&param_84), (&param_85), (&param_86));
            color_B_1 = (_e1001 & vec3<i32>(255i, 255i, 255i));
            let _e1003 = s_6;
            param_87 = _e1003;
            let _e1004 = ss_4;
            param_88 = _e1004;
            let _e1005 = colors_0_4;
            param_89 = _e1005;
            let _e1006 = colors_1_4;
            param_90 = _e1006;
            let _e1007 = color_c;
            param_91 = _e1007;
            let _e1008 = selectColorInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_87), (&param_88), (&param_89), (&param_90), (&param_91));
            color_C = (_e1008 & vec3<i32>(255i, 255i, 255i));
            let _e1010 = s_6;
            param_92 = _e1010;
            let _e1011 = ss_4;
            param_93 = _e1011;
            let _e1012 = colors_0_4;
            param_94 = _e1012;
            let _e1013 = colors_1_4;
            param_95 = _e1013;
            let _e1014 = color_d;
            param_96 = _e1014;
            let _e1015 = selectColorInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_92), (&param_93), (&param_94), (&param_95), (&param_96));
            color_D = _e1015;
            let _e1016 = color_bias;
            if (_e1016 != 3u) {
                let _e1018 = color_A_1;
                param_97 = _e1018;
                let _e1019 = color_B_1;
                param_98 = _e1019;
                let _e1020 = color_C;
                param_99 = _e1020;
                let _e1021 = color_D;
                param_100 = _e1021;
                let _e1022 = color_bias;
                param_101 = _e1022;
                let _e1023 = color_op;
                param_102 = _e1023;
                let _e1024 = color_scale;
                param_103 = _e1024;
                let _e1025 = tevLerp3_u0028_vi3_u003b_vi3_u003b_vi3_u003b_vi3_u003b_u1_u003b_b1_u003b_u1_u003b((&param_97), (&param_98), (&param_99), (&param_100), (&param_101), (&param_102), (&param_103));
                color_2 = _e1025;
            } else {
                let _e1026 = color_compare_op;
                if (_e1026 == 6u) {
                    let _e1029 = color_A_1[0u];
                    let _e1031 = color_B_1[0u];
                    if (_e1029 > _e1031) {
                        let _e1034 = color_C[0u];
                        local_8 = _e1034;
                    } else {
                        local_8 = 0i;
                    }
                    let _e1035 = local_8;
                    color_2[0u] = _e1035;
                    let _e1038 = color_A_1[1u];
                    let _e1040 = color_B_1[1u];
                    if (_e1038 > _e1040) {
                        let _e1043 = color_C[1u];
                        local_9 = _e1043;
                    } else {
                        local_9 = 0i;
                    }
                    let _e1044 = local_9;
                    color_2[1u] = _e1044;
                    let _e1047 = color_A_1[2u];
                    let _e1049 = color_B_1[2u];
                    if (_e1047 > _e1049) {
                        let _e1052 = color_C[2u];
                        local_10 = _e1052;
                    } else {
                        local_10 = 0i;
                    }
                    let _e1053 = local_10;
                    color_2[2u] = _e1053;
                } else {
                    let _e1055 = color_compare_op;
                    if (_e1055 == 7u) {
                        let _e1058 = color_A_1[0u];
                        let _e1060 = color_B_1[0u];
                        if (_e1058 == _e1060) {
                            let _e1063 = color_C[0u];
                            local_11 = _e1063;
                        } else {
                            local_11 = 0i;
                        }
                        let _e1064 = local_11;
                        color_2[0u] = _e1064;
                        let _e1067 = color_A_1[1u];
                        let _e1069 = color_B_1[1u];
                        if (_e1067 == _e1069) {
                            let _e1072 = color_C[1u];
                            local_12 = _e1072;
                        } else {
                            local_12 = 0i;
                        }
                        let _e1073 = local_12;
                        color_2[1u] = _e1073;
                        let _e1076 = color_A_1[2u];
                        let _e1078 = color_B_1[2u];
                        if (_e1076 == _e1078) {
                            let _e1081 = color_C[2u];
                            local_13 = _e1081;
                        } else {
                            local_13 = 0i;
                        }
                        let _e1082 = local_13;
                        color_2[2u] = _e1082;
                    } else {
                        let _e1084 = color_compare_op;
                        param_104 = _e1084;
                        let _e1085 = color_A_1;
                        param_105 = _e1085;
                        let _e1086 = color_B_1;
                        param_106 = _e1086;
                        let _e1087 = tevCompare_u0028_u1_u003b_vi3_u003b_vi3_u003b((&param_104), (&param_105), (&param_106));
                        let _e1088 = color_C;
                        color_2 = select(vec3<i32>(0i, 0i, 0i), _e1088, vec3(_e1087));
                    }
                }
                let _e1091 = color_D;
                let _e1092 = color_2;
                color_2 = (_e1091 + _e1092);
            }
            let _e1094 = color_clamp;
            if _e1094 {
                let _e1095 = color_2;
                color_2 = clamp(_e1095, vec3(0i), vec3(255i));
            } else {
                let _e1099 = color_2;
                color_2 = clamp(_e1099, vec3(-1024i), vec3(1023i));
            }
            let _e1103 = color_dest;
            if (_e1103 < 2u) {
                let _e1105 = color_dest;
                if (_e1105 < 1u) {
                    let _e1107 = color_2;
                    let _e1110 = s_6.Reg[0i];
                    s_6.Reg[0i] = vec4<i32>(_e1107.x, _e1107.y, _e1107.z, _e1110.w);
                } else {
                    let _e1116 = color_2;
                    let _e1119 = s_6.Reg[1i];
                    s_6.Reg[1i] = vec4<i32>(_e1116.x, _e1116.y, _e1116.z, _e1119.w);
                }
            } else {
                let _e1125 = color_dest;
                if (_e1125 < 3u) {
                    let _e1127 = color_2;
                    let _e1130 = s_6.Reg[2i];
                    s_6.Reg[2i] = vec4<i32>(_e1127.x, _e1127.y, _e1127.z, _e1130.w);
                } else {
                    let _e1136 = color_2;
                    let _e1139 = s_6.Reg[3i];
                    s_6.Reg[3i] = vec4<i32>(_e1136.x, _e1136.y, _e1136.z, _e1139.w);
                }
            }
            let _e1146 = ss_4.ac;
            alpha_a = extractBits(_e1146, bitcast<u32>(13i), bitcast<u32>(3i));
            let _e1151 = ss_4.ac;
            alpha_b = extractBits(_e1151, bitcast<u32>(10i), bitcast<u32>(3i));
            let _e1156 = ss_4.ac;
            alpha_c = extractBits(_e1156, bitcast<u32>(7i), bitcast<u32>(3i));
            let _e1161 = ss_4.ac;
            alpha_d = extractBits(_e1161, bitcast<u32>(4i), bitcast<u32>(3i));
            let _e1166 = ss_4.ac;
            alpha_bias = extractBits(_e1166, bitcast<u32>(16i), bitcast<u32>(2i));
            let _e1171 = ss_4.ac;
            alpha_op = (extractBits(_e1171, bitcast<u32>(18i), bitcast<u32>(1i)) != 0u);
            let _e1177 = ss_4.ac;
            alpha_clamp = (extractBits(_e1177, bitcast<u32>(19i), bitcast<u32>(1i)) != 0u);
            let _e1183 = ss_4.ac;
            alpha_scale = extractBits(_e1183, bitcast<u32>(20i), bitcast<u32>(2i));
            let _e1188 = ss_4.ac;
            alpha_dest = extractBits(_e1188, bitcast<u32>(22i), bitcast<u32>(2i));
            let _e1192 = alpha_scale;
            let _e1195 = alpha_op;
            alpha_compare_op = ((_e1192 << bitcast<u32>(1i)) | select(0u, 1u, _e1195));
            alpha_A = 0i;
            alpha_B = 0i;
            let _e1198 = alpha_bias;
            let _e1200 = alpha_compare_op;
            if ((_e1198 != 3u) || (_e1200 > 5u)) {
                let _e1203 = s_6;
                param_107 = _e1203;
                let _e1204 = ss_4;
                param_108 = _e1204;
                let _e1205 = colors_0_4;
                param_109 = _e1205;
                let _e1206 = colors_1_4;
                param_110 = _e1206;
                let _e1207 = alpha_a;
                param_111 = _e1207;
                let _e1208 = selectAlphaInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_107), (&param_108), (&param_109), (&param_110), (&param_111));
                alpha_A = (_e1208 & 255i);
                let _e1210 = s_6;
                param_112 = _e1210;
                let _e1211 = ss_4;
                param_113 = _e1211;
                let _e1212 = colors_0_4;
                param_114 = _e1212;
                let _e1213 = colors_1_4;
                param_115 = _e1213;
                let _e1214 = alpha_b;
                param_116 = _e1214;
                let _e1215 = selectAlphaInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_112), (&param_113), (&param_114), (&param_115), (&param_116));
                alpha_B = (_e1215 & 255i);
            }
            let _e1217 = s_6;
            param_117 = _e1217;
            let _e1218 = ss_4;
            param_118 = _e1218;
            let _e1219 = colors_0_4;
            param_119 = _e1219;
            let _e1220 = colors_1_4;
            param_120 = _e1220;
            let _e1221 = alpha_c;
            param_121 = _e1221;
            let _e1222 = selectAlphaInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_117), (&param_118), (&param_119), (&param_120), (&param_121));
            alpha_C = (_e1222 & 255i);
            let _e1224 = s_6;
            param_122 = _e1224;
            let _e1225 = ss_4;
            param_123 = _e1225;
            let _e1226 = colors_0_4;
            param_124 = _e1226;
            let _e1227 = colors_1_4;
            param_125 = _e1227;
            let _e1228 = alpha_d;
            param_126 = _e1228;
            let _e1229 = selectAlphaInput_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_struct_u002d_StageState_u002d_u1_u002d_u1_u002d_u1_u002d_u11_u003b_vf4_u003b_vf4_u003b_u1_u003b((&param_122), (&param_123), (&param_124), (&param_125), (&param_126));
            alpha_D = _e1229;
            let _e1230 = alpha_bias;
            if (_e1230 != 3u) {
                let _e1232 = alpha_A;
                param_127 = _e1232;
                let _e1233 = alpha_B;
                param_128 = _e1233;
                let _e1234 = alpha_C;
                param_129 = _e1234;
                let _e1235 = alpha_D;
                param_130 = _e1235;
                let _e1236 = alpha_bias;
                param_131 = _e1236;
                let _e1237 = alpha_op;
                param_132 = _e1237;
                let _e1238 = alpha_scale;
                param_133 = _e1238;
                let _e1239 = tevLerp_u0028_i1_u003b_i1_u003b_i1_u003b_i1_u003b_u1_u003b_b1_u003b_u1_u003b((&param_127), (&param_128), (&param_129), (&param_130), (&param_131), (&param_132), (&param_133));
                alpha = _e1239;
            } else {
                let _e1240 = alpha_compare_op;
                if (_e1240 == 6u) {
                    let _e1242 = alpha_A;
                    let _e1243 = alpha_B;
                    let _e1245 = alpha_C;
                    alpha = select(0i, _e1245, (_e1242 > _e1243));
                } else {
                    let _e1247 = alpha_compare_op;
                    if (_e1247 == 7u) {
                        let _e1249 = alpha_A;
                        let _e1250 = alpha_B;
                        let _e1252 = alpha_C;
                        alpha = select(0i, _e1252, (_e1249 == _e1250));
                    } else {
                        let _e1254 = alpha_compare_op;
                        param_134 = _e1254;
                        let _e1255 = color_A_1;
                        param_135 = _e1255;
                        let _e1256 = color_B_1;
                        param_136 = _e1256;
                        let _e1257 = tevCompare_u0028_u1_u003b_vi3_u003b_vi3_u003b((&param_134), (&param_135), (&param_136));
                        let _e1258 = alpha_C;
                        alpha = select(0i, _e1258, _e1257);
                    }
                }
                let _e1260 = alpha_D;
                let _e1261 = alpha;
                alpha = (_e1260 + _e1261);
            }
            let _e1263 = alpha_clamp;
            if _e1263 {
                let _e1264 = alpha;
                alpha = clamp(_e1264, 0i, 255i);
            } else {
                let _e1266 = alpha;
                alpha = clamp(_e1266, -1024i, 1023i);
            }
            let _e1268 = alpha_dest;
            if (_e1268 < 2u) {
                let _e1270 = alpha_dest;
                if (_e1270 < 1u) {
                    let _e1272 = alpha;
                    s_6.Reg[0i][3u] = _e1272;
                } else {
                    let _e1276 = alpha;
                    s_6.Reg[1i][3u] = _e1276;
                }
            } else {
                let _e1280 = alpha_dest;
                if (_e1280 < 3u) {
                    let _e1282 = alpha;
                    s_6.Reg[2i][3u] = _e1282;
                } else {
                    let _e1286 = alpha;
                    s_6.Reg[3i][3u] = _e1286;
                }
            }
            continue;
        } else {
            break;
        }
        continuing {
            let _e1290 = stage;
            stage = (_e1290 + bitcast<u32>(1i));
        }
    }
    let _e1293 = num_stages;
    let _e1297 = unnamed.bpmem_pack1_[_e1293][0u];
    let _e1301 = s_6;
    param_137 = _e1301;
    param_138 = extractBits(_e1297, bitcast<u32>(22i), bitcast<u32>(2i));
    let _e1302 = getTevReg_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_u1_u003b((&param_137), (&param_138));
    let _e1303 = _e1302.xyz;
    let _e1304 = TevResult;
    TevResult = vec4<i32>(_e1303.x, _e1303.y, _e1303.z, _e1304.w);
    let _e1310 = num_stages;
    let _e1314 = unnamed.bpmem_pack1_[_e1310][1u];
    let _e1318 = s_6;
    param_139 = _e1318;
    param_140 = extractBits(_e1314, bitcast<u32>(22i), bitcast<u32>(2i));
    let _e1319 = getTevReg_u0028_struct_u002d_State_u002d_vi4_u005b_4_u005d_u002d_vi4_u002d_vi4_u002d_i11_u003b_u1_u003b((&param_139), (&param_140));
    TevResult[3u] = _e1319.w;
    let _e1322 = TevResult;
    TevResult = (_e1322 & vec4(255i));
    let _e1328 = unnamed.czbias[1i][0u];
    let _e1330 = clipPos_1[2u];
    let _e1332 = clipPos_1[3u];
    let _e1337 = unnamed.czbias[1i][1u];
    zCoord = (_e1328 + i32(((_e1330 / _e1332) * f32(_e1337))));
    let _e1342 = zCoord;
    early_zCoord = _e1342;
    let _e1344 = unnamed.bpmem_ztex_op;
    if (_e1344 != 0u) {
        let _e1349 = unnamed.czbias[1i][3u];
        ztex = _e1349;
        let _e1351 = s_6.RawTexColor;
        param_141 = _e1351;
        let _e1354 = unnamed.czbias[0i];
        param_142 = _e1354;
        let _e1355 = idot_u0028_vi4_u003b_vi4_u003b((&param_141), (&param_142));
        let _e1356 = ztex;
        ztex = (_e1356 + _e1355);
        let _e1359 = unnamed.bpmem_ztex_op;
        let _e1361 = zCoord;
        let _e1363 = ztex;
        ztex = (_e1363 + select(0i, _e1361, (_e1359 == 1u)));
        let _e1365 = ztex;
        zCoord = (_e1365 & 16777215i);
    }
    let _e1368 = unnamed.bpmem_alphaTest;
    if (_e1368 != 0u) {
        let _e1371 = unnamed.bpmem_alphaTest;
        let _e1376 = TevResult[3u];
        param_143 = _e1376;
        let _e1379 = unnamed.alphaRef[0u];
        param_144 = _e1379;
        param_145 = extractBits(_e1371, bitcast<u32>(16i), bitcast<u32>(3i));
        let _e1380 = alphaCompare_u0028_i1_u003b_i1_u003b_u1_u003b((&param_143), (&param_144), (&param_145));
        comp0_ = _e1380;
        let _e1382 = unnamed.bpmem_alphaTest;
        let _e1387 = TevResult[3u];
        param_146 = _e1387;
        let _e1390 = unnamed.alphaRef[1u];
        param_147 = _e1390;
        param_148 = extractBits(_e1382, bitcast<u32>(19i), bitcast<u32>(3i));
        let _e1391 = alphaCompare_u0028_i1_u003b_i1_u003b_u1_u003b((&param_146), (&param_147), (&param_148));
        comp1_ = _e1391;
        let _e1393 = unnamed.bpmem_alphaTest;
        alpha_op_1 = extractBits(_e1393, bitcast<u32>(22i), bitcast<u32>(2i));
        let _e1397 = alpha_op_1;
        if (_e1397 == 0u) {
            let _e1399 = comp0_;
            let _e1400 = comp1_;
            alpha_pass = (_e1399 && _e1400);
        } else {
            let _e1402 = alpha_op_1;
            if (_e1402 == 1u) {
                let _e1404 = comp0_;
                let _e1405 = comp1_;
                alpha_pass = (_e1404 || _e1405);
            } else {
                let _e1407 = alpha_op_1;
                if (_e1407 == 2u) {
                    let _e1409 = comp0_;
                    let _e1410 = comp1_;
                    alpha_pass = (_e1409 != _e1410);
                } else {
                    let _e1412 = comp0_;
                    let _e1413 = comp1_;
                    alpha_pass = (_e1412 == _e1413);
                }
            }
        }
        let _e1415 = alpha_pass;
        if !(_e1415) {
            discard;
        }
    }
    let _e1418 = TevResult[3u];
    if (_e1418 == 1i) {
        TevResult[3u] = 0i;
    }
    let _e1422 = unnamed.bpmem_dither;
    if (_e1422 != 0u) {
        let _e1424 = rawpos;
        dither = (vec2<i32>(_e1424.xy) & vec2(1i));
        let _e1429 = TevResult;
        let _e1431 = TevResult;
        let _e1438 = dither[0u];
        let _e1440 = dither[1u];
        let _e1446 = dither[1u];
        let _e1448 = (((_e1429.xyz - (_e1431.xyz >> bitcast<vec3<u32>>(vec3(6i)))) + vec3(((_e1438 ^ _e1440) * 2i))) + vec3(_e1446));
        let _e1449 = TevResult;
        TevResult = vec4<i32>(_e1448.x, _e1448.y, _e1448.z, _e1449.w);
    }
    let _e1456 = unnamed.bpmem_fogParam3_;
    fog_function = extractBits(_e1456, bitcast<u32>(21i), bitcast<u32>(3i));
    let _e1460 = fog_function;
    if (_e1460 != 0u) {
        let _e1463 = unnamed.bpmem_fogParam3_;
        if (extractBits(_e1463, bitcast<u32>(20i), bitcast<u32>(1i)) == 0u) {
            let _e1470 = unnamed.cfogf[0u];
            let _e1474 = unnamed.cfogi[1u];
            let _e1475 = zCoord;
            let _e1478 = unnamed.cfogi[3u];
            ze = ((_e1470 * 16777216f) / f32((_e1474 - (_e1475 >> bitcast<u32>(_e1478)))));
        } else {
            let _e1486 = unnamed.cfogf[0u];
            let _e1487 = zCoord;
            ze = ((_e1486 * f32(_e1487)) / 16777216f);
        }
        let _e1492 = unnamed.bpmem_fogRangeBase;
        if (extractBits(_e1492, bitcast<u32>(10i), bitcast<u32>(1i)) != 0u) {
            let _e1498 = rawpos[0u];
            let _e1501 = unnamed.cfogf[3u];
            let _e1507 = unnamed.cfogf[2u];
            offset = (((2f * (_e1498 / _e1501)) - 1f) - _e1507);
            let _e1509 = offset;
            floatindex = clamp((9f - (abs(_e1509) * 9f)), 0f, 9f);
            let _e1514 = floatindex;
            indexlower = u32(_e1514);
            let _e1516 = indexlower;
            indexupper = (_e1516 + 1u);
            let _e1518 = indexlower;
            let _e1521 = indexlower;
            let _e1526 = unnamed.cfogrange[(_e1518 >> bitcast<u32>(2u))][(_e1521 & 3u)];
            klower = _e1526;
            let _e1527 = indexupper;
            let _e1530 = indexupper;
            let _e1535 = unnamed.cfogrange[(_e1527 >> bitcast<u32>(2u))][(_e1530 & 3u)];
            kupper = _e1535;
            let _e1536 = klower;
            let _e1537 = kupper;
            let _e1538 = floatindex;
            k = mix(_e1536, _e1537, fract(_e1538));
            let _e1541 = offset;
            let _e1542 = offset;
            let _e1544 = k;
            let _e1545 = k;
            let _e1549 = k;
            x_adjust = (sqrt(((_e1541 * _e1542) + (_e1544 * _e1545))) / _e1549);
            let _e1551 = x_adjust;
            let _e1552 = ze;
            ze = (_e1552 * _e1551);
        }
        let _e1554 = ze;
        let _e1557 = unnamed.cfogf[1u];
        fog = clamp((_e1554 - _e1557), 0f, 1f);
        let _e1560 = fog_function;
        if (_e1560 >= 4u) {
            let _e1562 = fog_function;
            switch bitcast<i32>(_e1562) {
                case 4: {
                    let _e1564 = fog;
                    fog = (1f - exp2((-8f * _e1564)));
                    break;
                }
                case 5: {
                    let _e1568 = fog;
                    let _e1570 = fog;
                    fog = (1f - exp2(((-8f * _e1568) * _e1570)));
                    break;
                }
                case 6: {
                    let _e1574 = fog;
                    fog = exp2((-8f * (1f - _e1574)));
                    break;
                }
                case 7: {
                    let _e1578 = fog;
                    fog = (1f - _e1578);
                    let _e1580 = fog;
                    let _e1582 = fog;
                    fog = exp2(((-8f * _e1580) * _e1582));
                    break;
                }
                default: {
                }
            }
        }
        let _e1585 = fog;
        param_149 = (_e1585 * 256f);
        let _e1587 = iround_u0028_f1_u003b((&param_149));
        ifog = _e1587;
        let _e1588 = TevResult;
        let _e1590 = ifog;
        let _e1595 = unnamed.cfogcolor;
        let _e1597 = ifog;
        let _e1603 = (((_e1588.xyz * vec3((256i - _e1590))) + (_e1595.xyz * vec3(_e1597))) >> bitcast<vec3<u32>>(vec3(8i)));
        let _e1604 = TevResult;
        TevResult = vec4<i32>(_e1603.x, _e1603.y, _e1603.z, _e1604.w);
    }
    let _e1611 = unnamed.logic_op_enable;
    if (_e1611 != 0u) {
        let _e1614 = unnamed.logic_op_mode;
        switch bitcast<i32>(_e1614) {
            case 0: {
                TevResult = vec4<i32>(0i, 0i, 0i, 0i);
                break;
            }
            case 12: {
                let _e1616 = TevResult;
                TevResult = (_e1616 ^ vec4(255i));
                break;
            }
            case 10, 15: {
                TevResult = vec4<i32>(255i, 255i, 255i, 255i);
                break;
            }
            default: {
                break;
            }
        }
    }
    let _e1620 = unnamed.bpmem_rgba6_format;
    if (_e1620 != 0u) {
        let _e1622 = TevResult;
        let _e1629 = (vec3<f32>((_e1622.xyz >> bitcast<vec3<u32>>(vec3(2i)))) / vec3(63f));
        let _e1630 = ocol0_;
        ocol0_ = vec4<f32>(_e1629.x, _e1629.y, _e1629.z, _e1630.w);
    } else {
        let _e1636 = TevResult;
        let _e1640 = (vec3<f32>(_e1636.xyz) / vec3(255f));
        let _e1641 = ocol0_;
        ocol0_ = vec4<f32>(_e1640.x, _e1640.y, _e1640.z, _e1641.w);
    }
    let _e1648 = unnamed.bpmem_dstalpha;
    if (_e1648 != 0u) {
        let _e1651 = unnamed.bpmem_dstalpha;
        ocol0_[3u] = (f32((extractBits(_e1651, bitcast<u32>(0i), bitcast<u32>(8i)) >> bitcast<u32>(2i))) / 63f);
    } else {
        let _e1661 = TevResult[3u];
        ocol0_[3u] = (f32((_e1661 >> bitcast<u32>(2i))) / 63f);
    }
    let _e1668 = TevResult[3u];
    ocol1_ = vec4<f32>(0f, 0f, 0f, (f32(_e1668) / 255f));
    return;
}

@fragment 
fn main(@builtin(position) gl_FragCoord: vec4<f32>, @location(2) tex0_: vec3<f32>, @location(3) tex1_: vec3<f32>, @location(4) tex2_: vec3<f32>, @location(5) tex3_: vec3<f32>, @location(6) tex4_: vec3<f32>, @location(7) tex5_: vec3<f32>, @location(8) tex6_: vec3<f32>, @location(9) tex7_: vec3<f32>, @location(0) colors_0_: vec4<f32>, @location(1) colors_1_: vec4<f32>, @location(10) clipPos: vec4<f32>) -> FragmentOutput {
    gl_FragCoord_1 = gl_FragCoord;
    tex0_1 = tex0_;
    tex1_1 = tex1_;
    tex2_1 = tex2_;
    tex3_1 = tex3_;
    tex4_1 = tex4_;
    tex5_1 = tex5_;
    tex6_1 = tex6_;
    tex7_1 = tex7_;
    colors_0_4 = colors_0_;
    colors_1_4 = colors_1_;
    clipPos_1 = clipPos;
    main_1();
    let _e26 = ocol0_;
    let _e27 = ocol1_;
    return FragmentOutput(_e26, _e27);
}
