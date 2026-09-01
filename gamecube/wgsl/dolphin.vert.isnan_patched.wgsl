struct Light {
    color: vec4<i32>,
    cosatt: vec4<f32>,
    distatt: vec4<f32>,
    pos: vec4<f32>,
    dir: vec4<f32>,
}

struct VSBlock {
    components: u32,
    xfmem_dualTexInfo: u32,
    xfmem_numColorChans: u32,
    missing_color_hex: u32,
    missing_color_value: vec4<f32>,
    cpnmtx: array<vec4<f32>, 6>,
    cproj: array<vec4<f32>, 4>,
    cmtrl: array<vec4<i32>, 4>,
    clights: array<Light, 8>,
    ctexmtx: array<vec4<f32>, 24>,
    ctrmtx: array<vec4<f32>, 64>,
    cnmtx: array<vec4<f32>, 32>,
    cpostmtx: array<vec4<f32>, 64>,
    cpixelcenter: vec4<f32>,
    cviewport: vec2<f32>,
    xfmem_pack1_: array<vec4<u32>, 8>,
    cnormal: vec4<f32>,
    ctangent: vec4<f32>,
    cbinormal: vec4<f32>,
    vertex_stride: u32,
    vertex_offset_rawnormal: u32,
    vertex_offset_rawtangent: u32,
    vertex_offset_rawbinormal: u32,
    vertex_offset_rawpos: u32,
    vertex_offset_posmtx: u32,
    vertex_offset_rawcolor0_: u32,
    vertex_offset_rawcolor1_: u32,
    vertex_offset_rawtex: array<vec4<u32>, 2>,
}

struct VS_OUTPUT {
    pos: vec4<f32>,
    colors_0_: vec4<f32>,
    colors_1_: vec4<f32>,
    tex0_: vec3<f32>,
    clipPos: vec4<f32>,
}

struct gl_PerVertex {
    @builtin(position) gl_Position: vec4<f32>,
    gl_PointSize: f32,
    gl_ClipDistance: array<f32, 1>,
    gl_CullDistance: array<f32, 1>,
}

struct VertexOutput {
    @location(2) member: vec3<f32>,
    @location(3) member_1: vec4<f32>,
    @location(0) member_2: vec4<f32>,
    @location(1) member_3: vec4<f32>,
    @builtin(position) gl_Position: vec4<f32>,
}

@group(0) @binding(2) 
var<uniform> unnamed: VSBlock;
var<private> posmtx_1: vec4<u32>;
var<private> rawpos_1: vec4<f32>;
var<private> rawnormal_1: vec3<f32>;
var<private> rawtangent_1: vec3<f32>;
var<private> rawbinormal_1: vec3<f32>;
var<private> rawcolor0_1: vec4<f32>;
var<private> rawcolor1_1: vec4<f32>;
var<private> rawtex0_1: vec3<f32>;
var<private> rawtex1_1: vec3<f32>;
var<private> rawtex2_1: vec3<f32>;
var<private> rawtex3_1: vec3<f32>;
var<private> rawtex4_1: vec3<f32>;
var<private> rawtex5_1: vec3<f32>;
var<private> rawtex6_1: vec3<f32>;
var<private> rawtex7_1: vec3<f32>;
var<private> tex0_: vec3<f32>;
var<private> clipPos: vec4<f32>;
var<private> colors_0_: vec4<f32>;
var<private> colors_1_: vec4<f32>;
var<private> unnamed_1: gl_PerVertex = gl_PerVertex(vec4<f32>(0f, 0f, 0f, 1f), 1f, array<f32, 1>(), array<f32, 1>());

fn CalculateLighting_u0028_u1_u003b_u1_u003b_u1_u003b_vf3_u003b_vf3_u003b(index: ptr<function, u32>, attnfunc: ptr<function, u32>, diffusefunc: ptr<function, u32>, pos: ptr<function, vec3<f32>>, normal: ptr<function, vec3<f32>>) -> vec4<i32> {
    var ldir: vec3<f32>;
    var attn: f32;
    var local: f32;
    var cosAttn: vec3<f32>;
    var distAttn: vec3<f32>;
    var dist2_: f32;
    var dist: f32;

    let _e91 = (*attnfunc);
    switch bitcast<i32>(_e91) {
        case 2, 0: {
            let _e94 = (*index);
            let _e98 = unnamed.clights[_e94].pos;
            let _e100 = (*pos);
            ldir = normalize((_e98.xyz - _e100));
            attn = 1f;
            let _e103 = ldir;
            if (length(_e103) == 0f) {
                let _e106 = (*normal);
                ldir = _e106;
            }
            break;
        }
        case 1: {
            let _e107 = (*index);
            let _e111 = unnamed.clights[_e107].pos;
            let _e113 = (*pos);
            ldir = normalize((_e111.xyz - _e113));
            let _e116 = (*normal);
            let _e117 = ldir;
            if (dot(_e116, _e117) >= 0f) {
                let _e120 = (*normal);
                let _e121 = (*index);
                let _e125 = unnamed.clights[_e121].dir;
                local = max(0f, dot(_e120, _e125.xyz));
            } else {
                local = 0f;
            }
            let _e129 = local;
            attn = _e129;
            let _e130 = (*index);
            let _e134 = unnamed.clights[_e130].cosatt;
            cosAttn = _e134.xyz;
            let _e136 = (*diffusefunc);
            if (_e136 == 0u) {
                let _e138 = (*index);
                let _e142 = unnamed.clights[_e138].distatt;
                distAttn = _e142.xyz;
            } else {
                let _e144 = (*index);
                let _e148 = unnamed.clights[_e144].distatt;
                distAttn = normalize(_e148.xyz);
            }
            let _e151 = cosAttn;
            let _e152 = attn;
            let _e153 = attn;
            let _e154 = attn;
            let _e159 = distAttn;
            let _e160 = attn;
            let _e161 = attn;
            let _e162 = attn;
            attn = (max(0f, dot(_e151, vec3<f32>(1f, _e152, (_e153 * _e154)))) / dot(_e159, vec3<f32>(1f, _e160, (_e161 * _e162))));
            break;
        }
        case 3: {
            let _e167 = (*index);
            let _e171 = unnamed.clights[_e167].pos;
            let _e173 = (*pos);
            ldir = (_e171.xyz - _e173);
            let _e175 = ldir;
            let _e176 = ldir;
            dist2_ = dot(_e175, _e176);
            let _e178 = dist2_;
            dist = sqrt(_e178);
            let _e180 = ldir;
            let _e181 = dist;
            ldir = (_e180 / vec3(_e181));
            let _e184 = ldir;
            let _e185 = (*index);
            let _e189 = unnamed.clights[_e185].dir;
            attn = max(0f, dot(_e184, _e189.xyz));
            let _e193 = (*index);
            let _e198 = unnamed.clights[_e193].cosatt[0u];
            let _e199 = (*index);
            let _e204 = unnamed.clights[_e199].cosatt[1u];
            let _e205 = attn;
            let _e208 = (*index);
            let _e213 = unnamed.clights[_e208].cosatt[2u];
            let _e214 = attn;
            let _e216 = attn;
            let _e220 = (*index);
            let _e224 = unnamed.clights[_e220].distatt;
            let _e226 = dist;
            let _e227 = dist2_;
            attn = (max(0f, ((_e198 + (_e204 * _e205)) + ((_e213 * _e214) * _e216))) / dot(_e224.xyz, vec3<f32>(1f, _e226, _e227)));
            break;
        }
        default: {
            attn = 1f;
            let _e93 = (*normal);
            ldir = _e93;
            break;
        }
    }
    let _e231 = (*diffusefunc);
    switch bitcast<i32>(_e231) {
        case 0: {
            let _e233 = attn;
            let _e234 = (*index);
            let _e238 = unnamed.clights[_e234].color;
            return vec4<i32>(round((vec4<f32>(_e238) * _e233)));
        }
        case 1: {
            let _e243 = attn;
            let _e244 = ldir;
            let _e245 = (*normal);
            let _e248 = (*index);
            let _e252 = unnamed.clights[_e248].color;
            return vec4<i32>(round((vec4<f32>(_e252) * (_e243 * dot(_e244, _e245)))));
        }
        case 2: {
            let _e257 = attn;
            let _e258 = ldir;
            let _e259 = (*normal);
            let _e263 = (*index);
            let _e267 = unnamed.clights[_e263].color;
            return vec4<i32>(round((vec4<f32>(_e267) * (_e257 * max(0f, dot(_e258, _e259))))));
        }
        default: {
            return vec4<i32>(0i, 0i, 0i, 0i);
        }
    }
}

fn main_1() {
    var posidx: i32;
    var P0_: vec4<f32>;
    var P1_: vec4<f32>;
    var P2_: vec4<f32>;
    var normidx: i32;
    var local_1: i32;
    var N0_: vec3<f32>;
    var N1_: vec3<f32>;
    var N2_: vec3<f32>;
    var pos_1: vec4<f32>;
    var o: VS_OUTPUT;
    var _rawnormal: vec3<f32>;
    var _rawtangent: vec3<f32>;
    var _rawbinormal: vec3<f32>;
    var _normal: vec3<f32>;
    var _tangent: vec3<f32>;
    var _binormal: vec3<f32>;
    var use_color_1_: bool;
    var vertex_color_0_: vec4<f32>;
    var vertex_color_1_: vec4<f32>;
    var chan: u32;
    var colorreg: u32;
    var alphareg: u32;
    var mat: vec4<i32>;
    var lacc: vec4<i32>;
    var local_2: vec3<f32>;
    var local_3: f32;
    var local_4: vec3<f32>;
    var light_mask: u32;
    var attnfunc_1: u32;
    var diffusefunc_1: u32;
    var light_index: u32;
    var param: u32;
    var param_1: u32;
    var param_2: u32;
    var param_3: vec3<f32>;
    var param_4: vec3<f32>;
    var local_5: f32;
    var light_mask_1: u32;
    var attnfunc_2: u32;
    var diffusefunc_2: u32;
    var light_index_1: u32;
    var param_5: u32;
    var param_6: u32;
    var param_7: u32;
    var param_8: vec3<f32>;
    var param_9: vec3<f32>;
    var lit_color: vec4<f32>;
    var coord: vec4<f32>;
    var texMtxInfo: u32;
    var texgentype: u32;
    var light: u32;
    var source: u32;
    var output_tex: vec3<f32>;
    var ldir_1: vec3<f32>;
    var tmp: i32;
    var postMtxInfo: u32;
    var base_index: u32;
    var P0_1: vec4<f32>;
    var P1_1: vec4<f32>;
    var P2_1: vec4<f32>;
    var phi_1174_: bool;

    let _e141 = unnamed.components;
    if ((_e141 & 2u) != 0u) {
        let _e145 = posmtx_1[0u];
        posidx = bitcast<i32>(_e145);
        let _e147 = posidx;
        let _e150 = unnamed.ctrmtx[_e147];
        P0_ = _e150;
        let _e151 = posidx;
        let _e155 = unnamed.ctrmtx[(_e151 + 1i)];
        P1_ = _e155;
        let _e156 = posidx;
        let _e160 = unnamed.ctrmtx[(_e156 + 2i)];
        P2_ = _e160;
        let _e161 = posidx;
        if (_e161 >= 32i) {
            let _e163 = posidx;
            local_1 = (_e163 - 32i);
        } else {
            let _e165 = posidx;
            local_1 = _e165;
        }
        let _e166 = local_1;
        normidx = _e166;
        let _e167 = normidx;
        let _e170 = unnamed.cnmtx[_e167];
        N0_ = _e170.xyz;
        let _e172 = normidx;
        let _e176 = unnamed.cnmtx[(_e172 + 1i)];
        N1_ = _e176.xyz;
        let _e178 = normidx;
        let _e182 = unnamed.cnmtx[(_e178 + 2i)];
        N2_ = _e182.xyz;
    } else {
        let _e186 = unnamed.cpnmtx[0i];
        P0_ = _e186;
        let _e189 = unnamed.cpnmtx[1i];
        P1_ = _e189;
        let _e192 = unnamed.cpnmtx[2i];
        P2_ = _e192;
        let _e195 = unnamed.cpnmtx[3i];
        N0_ = _e195.xyz;
        let _e199 = unnamed.cpnmtx[4i];
        N1_ = _e199.xyz;
        let _e203 = unnamed.cpnmtx[5i];
        N2_ = _e203.xyz;
    }
    let _e205 = P0_;
    let _e206 = rawpos_1;
    let _e208 = P1_;
    let _e209 = rawpos_1;
    let _e211 = P2_;
    let _e212 = rawpos_1;
    pos_1 = vec4<f32>(dot(_e205, _e206), dot(_e208, _e209), dot(_e211, _e212), 1f);
    let _e217 = unnamed.cproj[0i];
    let _e218 = pos_1;
    let _e222 = unnamed.cproj[1i];
    let _e223 = pos_1;
    let _e227 = unnamed.cproj[2i];
    let _e228 = pos_1;
    let _e232 = unnamed.cproj[3i];
    let _e233 = pos_1;
    o.pos = vec4<f32>(dot(_e217, _e218), dot(_e222, _e223), dot(_e227, _e228), dot(_e232, _e233));
    let _e238 = unnamed.components;
    if ((_e238 & 1024u) != 0u) {
        let _e241 = rawnormal_1;
        _rawnormal = _e241;
    } else {
        let _e243 = unnamed.cnormal;
        _rawnormal = _e243.xyz;
    }
    let _e246 = unnamed.components;
    if ((_e246 & 2048u) != 0u) {
        let _e249 = rawtangent_1;
        _rawtangent = _e249;
    } else {
        let _e251 = unnamed.ctangent;
        _rawtangent = _e251.xyz;
    }
    let _e254 = unnamed.components;
    if ((_e254 & 4096u) != 0u) {
        let _e257 = rawbinormal_1;
        _rawbinormal = _e257;
    } else {
        let _e259 = unnamed.cbinormal;
        _rawbinormal = _e259.xyz;
    }
    let _e261 = N0_;
    let _e262 = _rawnormal;
    let _e264 = N1_;
    let _e265 = _rawnormal;
    let _e267 = N2_;
    let _e268 = _rawnormal;
    _normal = normalize(vec3<f32>(dot(_e261, _e262), dot(_e264, _e265), dot(_e267, _e268)));
    let _e272 = N0_;
    let _e273 = _rawtangent;
    let _e275 = N1_;
    let _e276 = _rawtangent;
    let _e278 = N2_;
    let _e279 = _rawtangent;
    _tangent = vec3<f32>(dot(_e272, _e273), dot(_e275, _e276), dot(_e278, _e279));
    let _e282 = N0_;
    let _e283 = _rawbinormal;
    let _e285 = N1_;
    let _e286 = _rawbinormal;
    let _e288 = N2_;
    let _e289 = _rawbinormal;
    _binormal = vec3<f32>(dot(_e282, _e283), dot(_e285, _e286), dot(_e288, _e289));
    let _e293 = unnamed.components;
    use_color_1_ = ((_e293 & 24576u) == 24576u);
    let _e297 = unnamed.components;
    if ((_e297 & 24576u) == 24576u) {
        let _e300 = rawcolor0_1;
        vertex_color_0_ = _e300;
        let _e301 = rawcolor1_1;
        vertex_color_1_ = _e301;
    } else {
        let _e303 = unnamed.components;
        if ((_e303 & 8192u) != 0u) {
            let _e306 = rawcolor0_1;
            vertex_color_0_ = _e306;
            let _e307 = rawcolor0_1;
            vertex_color_1_ = _e307;
        } else {
            let _e309 = unnamed.components;
            if ((_e309 & 16384u) != 0u) {
                let _e312 = rawcolor1_1;
                vertex_color_0_ = _e312;
                let _e313 = rawcolor1_1;
                vertex_color_1_ = _e313;
            } else {
                let _e315 = unnamed.missing_color_value;
                vertex_color_0_ = _e315;
                let _e317 = unnamed.missing_color_value;
                vertex_color_1_ = _e317;
            }
        }
    }
    chan = 0u;
    loop {
        let _e318 = chan;
        if (_e318 < 2u) {
            let _e320 = chan;
            let _e324 = unnamed.xfmem_pack1_[_e320][2u];
            colorreg = _e324;
            let _e325 = chan;
            let _e329 = unnamed.xfmem_pack1_[_e325][3u];
            alphareg = _e329;
            let _e330 = chan;
            let _e334 = unnamed.cmtrl[(_e330 + 2u)];
            mat = _e334;
            lacc = vec4<i32>(255i, 255i, 255i, 255i);
            let _e335 = colorreg;
            if (extractBits(_e335, bitcast<u32>(0i), bitcast<u32>(1i)) != 0u) {
                let _e340 = chan;
                if (_e340 == 0u) {
                    let _e342 = vertex_color_0_;
                    local_2 = _e342.xyz;
                } else {
                    let _e344 = vertex_color_1_;
                    local_2 = _e344.xyz;
                }
                let _e346 = local_2;
                let _e349 = vec3<i32>(round((_e346 * 255f)));
                let _e350 = mat;
                mat = vec4<i32>(_e349.x, _e349.y, _e349.z, _e350.w);
            }
            let _e356 = alphareg;
            if (extractBits(_e356, bitcast<u32>(0i), bitcast<u32>(1i)) != 0u) {
                let _e361 = chan;
                if (_e361 == 0u) {
                    let _e364 = vertex_color_0_[3u];
                    local_3 = _e364;
                } else {
                    let _e366 = vertex_color_1_[3u];
                    local_3 = _e366;
                }
                let _e367 = local_3;
                mat[3u] = i32(round((_e367 * 255f)));
            } else {
                let _e372 = chan;
                let _e377 = unnamed.cmtrl[(_e372 + 2u)][3u];
                mat[3u] = _e377;
            }
            let _e379 = colorreg;
            if (extractBits(_e379, bitcast<u32>(1i), bitcast<u32>(1i)) != 0u) {
                let _e384 = colorreg;
                if (extractBits(_e384, bitcast<u32>(6i), bitcast<u32>(1i)) != 0u) {
                    let _e389 = chan;
                    if (_e389 == 0u) {
                        let _e391 = vertex_color_0_;
                        local_4 = _e391.xyz;
                    } else {
                        let _e393 = vertex_color_1_;
                        local_4 = _e393.xyz;
                    }
                    let _e395 = local_4;
                    let _e398 = vec3<i32>(round((_e395 * 255f)));
                    let _e399 = lacc;
                    lacc = vec4<i32>(_e398.x, _e398.y, _e398.z, _e399.w);
                } else {
                    let _e405 = chan;
                    let _e408 = unnamed.cmtrl[_e405];
                    let _e409 = _e408.xyz;
                    let _e410 = lacc;
                    lacc = vec4<i32>(_e409.x, _e409.y, _e409.z, _e410.w);
                }
                let _e416 = colorreg;
                let _e420 = colorreg;
                light_mask = (extractBits(_e416, bitcast<u32>(2i), bitcast<u32>(4i)) | (extractBits(_e420, bitcast<u32>(11i), bitcast<u32>(4i)) << bitcast<u32>(4u)));
                let _e427 = colorreg;
                attnfunc_1 = extractBits(_e427, bitcast<u32>(9i), bitcast<u32>(2i));
                let _e431 = colorreg;
                diffusefunc_1 = extractBits(_e431, bitcast<u32>(7i), bitcast<u32>(2i));
                light_index = 0u;
                loop {
                    let _e435 = light_index;
                    if (_e435 < 8u) {
                        let _e437 = light_mask;
                        let _e438 = light_index;
                        if ((_e437 & (1u << bitcast<u32>(_e438))) != 0u) {
                            let _e443 = light_index;
                            param = _e443;
                            let _e444 = attnfunc_1;
                            param_1 = _e444;
                            let _e445 = diffusefunc_1;
                            param_2 = _e445;
                            let _e446 = pos_1;
                            param_3 = _e446.xyz;
                            let _e448 = _normal;
                            param_4 = _e448;
                            let _e449 = CalculateLighting_u0028_u1_u003b_u1_u003b_u1_u003b_vf3_u003b_vf3_u003b((&param), (&param_1), (&param_2), (&param_3), (&param_4));
                            let _e451 = lacc;
                            let _e453 = (_e451.xyz + _e449.xyz);
                            let _e454 = lacc;
                            lacc = vec4<i32>(_e453.x, _e453.y, _e453.z, _e454.w);
                        }
                        continue;
                    } else {
                        break;
                    }
                    continuing {
                        let _e460 = light_index;
                        light_index = (_e460 + bitcast<u32>(1i));
                    }
                }
            }
            let _e463 = alphareg;
            if (extractBits(_e463, bitcast<u32>(1i), bitcast<u32>(1i)) != 0u) {
                let _e468 = alphareg;
                if (extractBits(_e468, bitcast<u32>(6i), bitcast<u32>(1i)) != 0u) {
                    let _e474 = unnamed.components;
                    let _e475 = chan;
                    if ((_e474 & (8192u << bitcast<u32>(_e475))) != 0u) {
                        let _e480 = chan;
                        if (_e480 == 0u) {
                            let _e483 = vertex_color_0_[3u];
                            local_5 = _e483;
                        } else {
                            let _e485 = vertex_color_1_[3u];
                            local_5 = _e485;
                        }
                        let _e486 = local_5;
                        lacc[3u] = i32(round((_e486 * 255f)));
                    } else {
                        let _e492 = unnamed.components;
                        if ((_e492 & 8192u) != 0u) {
                            let _e496 = vertex_color_0_[3u];
                            lacc[3u] = i32(round((_e496 * 255f)));
                        } else {
                            lacc[3u] = 255i;
                        }
                    }
                } else {
                    let _e502 = chan;
                    let _e506 = unnamed.cmtrl[_e502][3u];
                    lacc[3u] = _e506;
                }
                let _e508 = alphareg;
                let _e512 = alphareg;
                light_mask_1 = (extractBits(_e508, bitcast<u32>(2i), bitcast<u32>(4i)) | (extractBits(_e512, bitcast<u32>(11i), bitcast<u32>(4i)) << bitcast<u32>(4u)));
                let _e519 = alphareg;
                attnfunc_2 = extractBits(_e519, bitcast<u32>(9i), bitcast<u32>(2i));
                let _e523 = alphareg;
                diffusefunc_2 = extractBits(_e523, bitcast<u32>(7i), bitcast<u32>(2i));
                light_index_1 = 0u;
                loop {
                    let _e527 = light_index_1;
                    if (_e527 < 8u) {
                        let _e529 = light_mask_1;
                        let _e530 = light_index_1;
                        if ((_e529 & (1u << bitcast<u32>(_e530))) != 0u) {
                            let _e535 = light_index_1;
                            param_5 = _e535;
                            let _e536 = attnfunc_2;
                            param_6 = _e536;
                            let _e537 = diffusefunc_2;
                            param_7 = _e537;
                            let _e538 = pos_1;
                            param_8 = _e538.xyz;
                            let _e540 = _normal;
                            param_9 = _e540;
                            let _e541 = CalculateLighting_u0028_u1_u003b_u1_u003b_u1_u003b_vf3_u003b_vf3_u003b((&param_5), (&param_6), (&param_7), (&param_8), (&param_9));
                            let _e544 = lacc[3u];
                            lacc[3u] = (_e544 + _e541.w);
                        }
                        continue;
                    } else {
                        break;
                    }
                    continuing {
                        let _e547 = light_index_1;
                        light_index_1 = (_e547 + bitcast<u32>(1i));
                    }
                }
            }
            let _e550 = lacc;
            lacc = clamp(_e550, vec4(0i), vec4(255i));
            let _e554 = mat;
            let _e555 = lacc;
            let _e556 = lacc;
            lit_color = (vec4<f32>(((_e554 * (_e555 + (_e556 >> bitcast<vec4<u32>>(vec4(7i))))) >> bitcast<vec4<u32>>(vec4(8i)))) / vec4(255f));
            let _e568 = chan;
            switch bitcast<i32>(_e568) {
                case 0: {
                    let _e570 = lit_color;
                    o.colors_0_ = _e570;
                    break;
                }
                case 1: {
                    let _e572 = lit_color;
                    o.colors_1_ = _e572;
                    break;
                }
                default: {
                }
            }
            continue;
        } else {
            break;
        }
        continuing {
            let _e574 = chan;
            chan = (_e574 + bitcast<u32>(1i));
        }
    }
    o.tex0_ = vec3<f32>(0f, 0f, 0f);
    coord = vec4<f32>(0f, 0f, 1f, 1f);
    let _e581 = unnamed.xfmem_pack1_[0i][0u];
    texMtxInfo = _e581;
    let _e582 = texMtxInfo;
    switch bitcast<i32>(extractBits(_e582, bitcast<u32>(7i), bitcast<u32>(5i))) {
        case 0: {
            let _e587 = rawpos_1;
            let _e588 = _e587.xyz;
            let _e589 = coord;
            coord = vec4<f32>(_e588.x, _e588.y, _e588.z, _e589.w);
            break;
        }
        case 1: {
            let _e596 = unnamed.components;
            if ((_e596 & 1024u) != 0u) {
                let _e599 = rawnormal_1;
                let _e600 = coord;
                coord = vec4<f32>(_e599.x, _e599.y, _e599.z, _e600.w);
            }
            break;
        }
        case 3: {
            let _e607 = unnamed.components;
            if ((_e607 & 2048u) != 0u) {
                let _e610 = rawtangent_1;
                let _e611 = coord;
                coord = vec4<f32>(_e610.x, _e610.y, _e610.z, _e611.w);
            }
            break;
        }
        case 4: {
            let _e618 = unnamed.components;
            if ((_e618 & 4096u) != 0u) {
                let _e621 = rawbinormal_1;
                let _e622 = coord;
                coord = vec4<f32>(_e621.x, _e621.y, _e621.z, _e622.w);
            }
            break;
        }
        case 5: {
            let _e629 = unnamed.components;
            if ((_e629 & 32768u) != 0u) {
                let _e633 = rawtex0_1[0u];
                let _e635 = rawtex0_1[1u];
                coord = vec4<f32>(_e633, _e635, 1f, 1f);
            }
            break;
        }
        case 6: {
            let _e638 = unnamed.components;
            if ((_e638 & 65536u) != 0u) {
                let _e642 = rawtex1_1[0u];
                let _e644 = rawtex1_1[1u];
                coord = vec4<f32>(_e642, _e644, 1f, 1f);
            }
            break;
        }
        case 7: {
            let _e647 = unnamed.components;
            if ((_e647 & 131072u) != 0u) {
                let _e651 = rawtex2_1[0u];
                let _e653 = rawtex2_1[1u];
                coord = vec4<f32>(_e651, _e653, 1f, 1f);
            }
            break;
        }
        case 8: {
            let _e656 = unnamed.components;
            if ((_e656 & 262144u) != 0u) {
                let _e660 = rawtex3_1[0u];
                let _e662 = rawtex3_1[1u];
                coord = vec4<f32>(_e660, _e662, 1f, 1f);
            }
            break;
        }
        case 9: {
            let _e665 = unnamed.components;
            if ((_e665 & 524288u) != 0u) {
                let _e669 = rawtex4_1[0u];
                let _e671 = rawtex4_1[1u];
                coord = vec4<f32>(_e669, _e671, 1f, 1f);
            }
            break;
        }
        case 10: {
            let _e674 = unnamed.components;
            if ((_e674 & 1048576u) != 0u) {
                let _e678 = rawtex5_1[0u];
                let _e680 = rawtex5_1[1u];
                coord = vec4<f32>(_e678, _e680, 1f, 1f);
            }
            break;
        }
        case 11: {
            let _e683 = unnamed.components;
            if ((_e683 & 2097152u) != 0u) {
                let _e687 = rawtex6_1[0u];
                let _e689 = rawtex6_1[1u];
                coord = vec4<f32>(_e687, _e689, 1f, 1f);
            }
            break;
        }
        case 12: {
            let _e692 = unnamed.components;
            if ((_e692 & 4194304u) != 0u) {
                let _e696 = rawtex7_1[0u];
                let _e698 = rawtex7_1[1u];
                coord = vec4<f32>(_e696, _e698, 1f, 1f);
            }
            break;
        }
        default: {
        }
    }
    let _e700 = texMtxInfo;
    if (extractBits(_e700, bitcast<u32>(2i), bitcast<u32>(1i)) == 0u) {
        coord[2u] = 1f;
    }
    let _e707 = coord[0u];
    let _e709 = coord[0u];
    if (_e707 != _e709) {
        coord[0u] = 1f;
    }
    let _e713 = coord[1u];
    let _e715 = coord[1u];
    if (_e713 != _e715) {
        coord[1u] = 1f;
    }
    let _e719 = coord[2u];
    let _e721 = coord[2u];
    if (_e719 != _e721) {
        coord[2u] = 1f;
    }
    let _e724 = texMtxInfo;
    texgentype = extractBits(_e724, bitcast<u32>(4i), bitcast<u32>(3i));
    let _e728 = texgentype;
    switch bitcast<i32>(_e728) {
        case 1: {
            let _e810 = texMtxInfo;
            light = extractBits(_e810, bitcast<u32>(15i), bitcast<u32>(3i));
            let _e814 = texMtxInfo;
            source = extractBits(_e814, bitcast<u32>(12i), bitcast<u32>(3i));
            let _e818 = source;
            switch bitcast<i32>(_e818) {
                case 0: {
                    let _e821 = o.tex0_;
                    output_tex = _e821;
                    break;
                }
                default: {
                    output_tex = vec3<f32>(0f, 0f, 0f);
                    break;
                }
            }
            let _e822 = light;
            let _e826 = unnamed.clights[_e822].pos;
            let _e828 = pos_1;
            ldir_1 = normalize((_e826.xyz - _e828.xyz));
            let _e832 = ldir_1;
            let _e833 = _tangent;
            let _e835 = ldir_1;
            let _e836 = _binormal;
            let _e839 = output_tex;
            output_tex = (_e839 + vec3<f32>(dot(_e832, _e833), dot(_e835, _e836), 0f));
            break;
        }
        case 2: {
            let _e843 = o.colors_0_[0u];
            let _e846 = o.colors_0_[1u];
            output_tex = vec3<f32>(_e843, _e846, 1f);
            break;
        }
        case 3: {
            let _e850 = o.colors_1_[0u];
            let _e853 = o.colors_1_[1u];
            output_tex = vec3<f32>(_e850, _e853, 1f);
            break;
        }
        case 0, default: {
            let _e731 = unnamed.components;
            if ((_e731 & 4u) != 0u) {
                tmp = 0i;
                switch bitcast<i32>(0u) {
                    case 0: {
                        let _e736 = rawtex0_1[2u];
                        tmp = i32(_e736);
                        break;
                    }
                    default: {
                    }
                }
                let _e738 = texMtxInfo;
                if (extractBits(_e738, bitcast<u32>(1i), bitcast<u32>(1i)) == 1u) {
                    let _e743 = coord;
                    let _e744 = tmp;
                    let _e747 = unnamed.ctrmtx[_e744];
                    let _e749 = coord;
                    let _e750 = tmp;
                    let _e754 = unnamed.ctrmtx[(_e750 + 1i)];
                    let _e756 = coord;
                    let _e757 = tmp;
                    let _e761 = unnamed.ctrmtx[(_e757 + 2i)];
                    output_tex = vec3<f32>(dot(_e743, _e747), dot(_e749, _e754), dot(_e756, _e761));
                } else {
                    let _e764 = coord;
                    let _e765 = tmp;
                    let _e768 = unnamed.ctrmtx[_e765];
                    let _e770 = coord;
                    let _e771 = tmp;
                    let _e775 = unnamed.ctrmtx[(_e771 + 1i)];
                    output_tex = vec3<f32>(dot(_e764, _e768), dot(_e770, _e775), 1f);
                }
            } else {
                let _e778 = texMtxInfo;
                if (extractBits(_e778, bitcast<u32>(1i), bitcast<u32>(1i)) == 1u) {
                    let _e783 = coord;
                    let _e786 = unnamed.ctexmtx[0i];
                    let _e788 = coord;
                    let _e791 = unnamed.ctexmtx[1i];
                    let _e793 = coord;
                    let _e796 = unnamed.ctexmtx[2i];
                    output_tex = vec3<f32>(dot(_e783, _e786), dot(_e788, _e791), dot(_e793, _e796));
                } else {
                    let _e799 = coord;
                    let _e802 = unnamed.ctexmtx[0i];
                    let _e804 = coord;
                    let _e807 = unnamed.ctexmtx[1i];
                    output_tex = vec3<f32>(dot(_e799, _e802), dot(_e804, _e807), 1f);
                }
            }
            break;
        }
    }
    let _e856 = unnamed.xfmem_dualTexInfo;
    if (_e856 != 0u) {
        let _e861 = unnamed.xfmem_pack1_[0i][1u];
        postMtxInfo = _e861;
        let _e862 = postMtxInfo;
        base_index = extractBits(_e862, bitcast<u32>(0i), bitcast<u32>(6i));
        let _e866 = base_index;
        let _e870 = unnamed.cpostmtx[(_e866 & 63u)];
        P0_1 = _e870;
        let _e871 = base_index;
        let _e876 = unnamed.cpostmtx[((_e871 + 1u) & 63u)];
        P1_1 = _e876;
        let _e877 = base_index;
        let _e882 = unnamed.cpostmtx[((_e877 + 2u) & 63u)];
        P2_1 = _e882;
        let _e883 = postMtxInfo;
        if (extractBits(_e883, bitcast<u32>(8i), bitcast<u32>(1i)) != 0u) {
            let _e888 = output_tex;
            output_tex = normalize(_e888);
        }
        let _e890 = P0_1;
        let _e892 = output_tex;
        let _e895 = P0_1[3u];
        let _e897 = P1_1;
        let _e899 = output_tex;
        let _e902 = P1_1[3u];
        let _e904 = P2_1;
        let _e906 = output_tex;
        let _e909 = P2_1[3u];
        output_tex = vec3<f32>((dot(_e890.xyz, _e892) + _e895), (dot(_e897.xyz, _e899) + _e902), (dot(_e904.xyz, _e906) + _e909));
    }
    let _e912 = texgentype;
    let _e913 = (_e912 == 0u);
    phi_1174_ = _e913;
    if _e913 {
        let _e915 = output_tex[2u];
        phi_1174_ = (_e915 == 0f);
    }
    let _e918 = phi_1174_;
    if _e918 {
        let _e919 = output_tex;
        let _e923 = clamp((_e919.xy / vec2(2f)), vec2<f32>(-1f, -1f), vec2<f32>(1f, 1f));
        let _e924 = output_tex;
        output_tex = vec3<f32>(_e923.x, _e923.y, _e924.z);
    }
    switch bitcast<i32>(0u) {
        case 0: {
            let _e930 = output_tex;
            o.tex0_ = _e930;
            break;
        }
        default: {
        }
    }
    let _e933 = unnamed.xfmem_numColorChans;
    if (_e933 == 0u) {
        o.colors_0_ = vec4<f32>(0f, 0f, 0f, 0f);
    }
    let _e937 = unnamed.xfmem_numColorChans;
    if (_e937 <= 1u) {
        o.colors_1_ = vec4<f32>(0f, 0f, 0f, 0f);
    }
    let _e941 = o.pos;
    o.clipPos = _e941;
    let _e945 = o.pos[3u];
    let _e948 = unnamed.cpixelcenter[3u];
    let _e952 = o.pos[2u];
    let _e955 = unnamed.cpixelcenter[2u];
    o.pos[2u] = ((_e945 * _e948) - (_e952 * _e955));
    let _e962 = o.pos[2u];
    let _e966 = o.pos[3u];
    o.pos[2u] = ((_e962 * 2f) - _e966);
    let _e971 = unnamed.cpixelcenter;
    let _e976 = o.pos;
    let _e978 = (_e976.xy * sign((_e971.xy * vec2<f32>(1f, -1f))));
    let _e980 = o.pos;
    o.pos = vec4<f32>(_e978.x, _e978.y, _e980.z, _e980.w);
    let _e987 = o.pos;
    let _e991 = o.pos[3u];
    let _e993 = unnamed.cpixelcenter;
    let _e996 = (_e987.xy - (_e993.xy * _e991));
    let _e998 = o.pos;
    o.pos = vec4<f32>(_e996.x, _e996.y, _e998.z, _e998.w);
    let _e1005 = o.tex0_;
    tex0_ = _e1005;
    let _e1007 = o.clipPos;
    clipPos = _e1007;
    let _e1009 = o.colors_0_;
    colors_0_ = _e1009;
    let _e1011 = o.colors_1_;
    colors_1_ = _e1011;
    let _e1013 = o.pos;
    unnamed_1.gl_Position = _e1013;
    return;
}

@vertex 
fn main(@location(1) posmtx: vec4<u32>, @location(0) rawpos: vec4<f32>, @location(2) rawnormal: vec3<f32>, @location(3) rawtangent: vec3<f32>, @location(4) rawbinormal: vec3<f32>, @location(5) rawcolor0_: vec4<f32>, @location(6) rawcolor1_: vec4<f32>, @location(8) rawtex0_: vec3<f32>, @location(9) rawtex1_: vec3<f32>, @location(10) rawtex2_: vec3<f32>, @location(11) rawtex3_: vec3<f32>, @location(12) rawtex4_: vec3<f32>, @location(13) rawtex5_: vec3<f32>, @location(14) rawtex6_: vec3<f32>, @location(15) rawtex7_: vec3<f32>) -> VertexOutput {
    posmtx_1 = posmtx;
    rawpos_1 = rawpos;
    rawnormal_1 = rawnormal;
    rawtangent_1 = rawtangent;
    rawbinormal_1 = rawbinormal;
    rawcolor0_1 = rawcolor0_;
    rawcolor1_1 = rawcolor1_;
    rawtex0_1 = rawtex0_;
    rawtex1_1 = rawtex1_;
    rawtex2_1 = rawtex2_;
    rawtex3_1 = rawtex3_;
    rawtex4_1 = rawtex4_;
    rawtex5_1 = rawtex5_;
    rawtex6_1 = rawtex6_;
    rawtex7_1 = rawtex7_;
    main_1();
    let _e37 = unnamed_1.gl_Position.y;
    unnamed_1.gl_Position.y = -(_e37);
    let _e39 = tex0_;
    let _e40 = clipPos;
    let _e41 = colors_0_;
    let _e42 = colors_1_;
    let _e43 = unnamed_1.gl_Position;
    return VertexOutput(_e39, _e40, _e41, _e42, _e43);
}
