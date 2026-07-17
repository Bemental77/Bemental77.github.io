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
    tex1_: vec3<f32>,
    tex2_: vec3<f32>,
    tex3_: vec3<f32>,
    tex4_: vec3<f32>,
    tex5_: vec3<f32>,
    tex6_: vec3<f32>,
    tex7_: vec3<f32>,
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
    @location(3) member_1: vec3<f32>,
    @location(4) member_2: vec3<f32>,
    @location(5) member_3: vec3<f32>,
    @location(6) member_4: vec3<f32>,
    @location(7) member_5: vec3<f32>,
    @location(8) member_6: vec3<f32>,
    @location(9) member_7: vec3<f32>,
    @location(10) member_8: vec4<f32>,
    @location(0) member_9: vec4<f32>,
    @location(1) member_10: vec4<f32>,
    @builtin(position) gl_Position: vec4<f32>,
}

@group(0) @binding(1) 
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
var<private> tex1_: vec3<f32>;
var<private> tex2_: vec3<f32>;
var<private> tex3_: vec3<f32>;
var<private> tex4_: vec3<f32>;
var<private> tex5_: vec3<f32>;
var<private> tex6_: vec3<f32>;
var<private> tex7_: vec3<f32>;
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

    let _e98 = (*attnfunc);
    switch bitcast<i32>(_e98) {
        case 2, 0: {
            let _e101 = (*index);
            let _e105 = unnamed.clights[_e101].pos;
            let _e107 = (*pos);
            ldir = normalize((_e105.xyz - _e107));
            attn = 1f;
            let _e110 = ldir;
            if (length(_e110) == 0f) {
                let _e113 = (*normal);
                ldir = _e113;
            }
            break;
        }
        case 1: {
            let _e114 = (*index);
            let _e118 = unnamed.clights[_e114].pos;
            let _e120 = (*pos);
            ldir = normalize((_e118.xyz - _e120));
            let _e123 = (*normal);
            let _e124 = ldir;
            if (dot(_e123, _e124) >= 0f) {
                let _e127 = (*normal);
                let _e128 = (*index);
                let _e132 = unnamed.clights[_e128].dir;
                local = max(0f, dot(_e127, _e132.xyz));
            } else {
                local = 0f;
            }
            let _e136 = local;
            attn = _e136;
            let _e137 = (*index);
            let _e141 = unnamed.clights[_e137].cosatt;
            cosAttn = _e141.xyz;
            let _e143 = (*diffusefunc);
            if (_e143 == 0u) {
                let _e145 = (*index);
                let _e149 = unnamed.clights[_e145].distatt;
                distAttn = _e149.xyz;
            } else {
                let _e151 = (*index);
                let _e155 = unnamed.clights[_e151].distatt;
                distAttn = normalize(_e155.xyz);
            }
            let _e158 = cosAttn;
            let _e159 = attn;
            let _e160 = attn;
            let _e161 = attn;
            let _e166 = distAttn;
            let _e167 = attn;
            let _e168 = attn;
            let _e169 = attn;
            attn = (max(0f, dot(_e158, vec3<f32>(1f, _e159, (_e160 * _e161)))) / dot(_e166, vec3<f32>(1f, _e167, (_e168 * _e169))));
            break;
        }
        case 3: {
            let _e174 = (*index);
            let _e178 = unnamed.clights[_e174].pos;
            let _e180 = (*pos);
            ldir = (_e178.xyz - _e180);
            let _e182 = ldir;
            let _e183 = ldir;
            dist2_ = dot(_e182, _e183);
            let _e185 = dist2_;
            dist = sqrt(_e185);
            let _e187 = ldir;
            let _e188 = dist;
            ldir = (_e187 / vec3(_e188));
            let _e191 = ldir;
            let _e192 = (*index);
            let _e196 = unnamed.clights[_e192].dir;
            attn = max(0f, dot(_e191, _e196.xyz));
            let _e200 = (*index);
            let _e205 = unnamed.clights[_e200].cosatt[0u];
            let _e206 = (*index);
            let _e211 = unnamed.clights[_e206].cosatt[1u];
            let _e212 = attn;
            let _e215 = (*index);
            let _e220 = unnamed.clights[_e215].cosatt[2u];
            let _e221 = attn;
            let _e223 = attn;
            let _e227 = (*index);
            let _e231 = unnamed.clights[_e227].distatt;
            let _e233 = dist;
            let _e234 = dist2_;
            attn = (max(0f, ((_e205 + (_e211 * _e212)) + ((_e220 * _e221) * _e223))) / dot(_e231.xyz, vec3<f32>(1f, _e233, _e234)));
            break;
        }
        default: {
            attn = 1f;
            let _e100 = (*normal);
            ldir = _e100;
            break;
        }
    }
    let _e238 = (*diffusefunc);
    switch bitcast<i32>(_e238) {
        case 0: {
            let _e240 = attn;
            let _e241 = (*index);
            let _e245 = unnamed.clights[_e241].color;
            return vec4<i32>(round((vec4<f32>(_e245) * _e240)));
        }
        case 1: {
            let _e250 = attn;
            let _e251 = ldir;
            let _e252 = (*normal);
            let _e255 = (*index);
            let _e259 = unnamed.clights[_e255].color;
            return vec4<i32>(round((vec4<f32>(_e259) * (_e250 * dot(_e251, _e252)))));
        }
        case 2: {
            let _e264 = attn;
            let _e265 = ldir;
            let _e266 = (*normal);
            let _e270 = (*index);
            let _e274 = unnamed.clights[_e270].color;
            return vec4<i32>(round((vec4<f32>(_e274) * (_e264 * max(0f, dot(_e265, _e266))))));
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
    var texgen: u32;
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
    var phi_1270_: bool;

    let _e149 = unnamed.components;
    if ((_e149 & 2u) != 0u) {
        let _e153 = posmtx_1[0u];
        posidx = bitcast<i32>(_e153);
        let _e155 = posidx;
        let _e158 = unnamed.ctrmtx[_e155];
        P0_ = _e158;
        let _e159 = posidx;
        let _e163 = unnamed.ctrmtx[(_e159 + 1i)];
        P1_ = _e163;
        let _e164 = posidx;
        let _e168 = unnamed.ctrmtx[(_e164 + 2i)];
        P2_ = _e168;
        let _e169 = posidx;
        if (_e169 >= 32i) {
            let _e171 = posidx;
            local_1 = (_e171 - 32i);
        } else {
            let _e173 = posidx;
            local_1 = _e173;
        }
        let _e174 = local_1;
        normidx = _e174;
        let _e175 = normidx;
        let _e178 = unnamed.cnmtx[_e175];
        N0_ = _e178.xyz;
        let _e180 = normidx;
        let _e184 = unnamed.cnmtx[(_e180 + 1i)];
        N1_ = _e184.xyz;
        let _e186 = normidx;
        let _e190 = unnamed.cnmtx[(_e186 + 2i)];
        N2_ = _e190.xyz;
    } else {
        let _e194 = unnamed.cpnmtx[0i];
        P0_ = _e194;
        let _e197 = unnamed.cpnmtx[1i];
        P1_ = _e197;
        let _e200 = unnamed.cpnmtx[2i];
        P2_ = _e200;
        let _e203 = unnamed.cpnmtx[3i];
        N0_ = _e203.xyz;
        let _e207 = unnamed.cpnmtx[4i];
        N1_ = _e207.xyz;
        let _e211 = unnamed.cpnmtx[5i];
        N2_ = _e211.xyz;
    }
    let _e213 = P0_;
    let _e214 = rawpos_1;
    let _e216 = P1_;
    let _e217 = rawpos_1;
    let _e219 = P2_;
    let _e220 = rawpos_1;
    pos_1 = vec4<f32>(dot(_e213, _e214), dot(_e216, _e217), dot(_e219, _e220), 1f);
    let _e225 = unnamed.cproj[0i];
    let _e226 = pos_1;
    let _e230 = unnamed.cproj[1i];
    let _e231 = pos_1;
    let _e235 = unnamed.cproj[2i];
    let _e236 = pos_1;
    let _e240 = unnamed.cproj[3i];
    let _e241 = pos_1;
    o.pos = vec4<f32>(dot(_e225, _e226), dot(_e230, _e231), dot(_e235, _e236), dot(_e240, _e241));
    let _e246 = unnamed.components;
    if ((_e246 & 1024u) != 0u) {
        let _e249 = rawnormal_1;
        _rawnormal = _e249;
    } else {
        let _e251 = unnamed.cnormal;
        _rawnormal = _e251.xyz;
    }
    let _e254 = unnamed.components;
    if ((_e254 & 2048u) != 0u) {
        let _e257 = rawtangent_1;
        _rawtangent = _e257;
    } else {
        let _e259 = unnamed.ctangent;
        _rawtangent = _e259.xyz;
    }
    let _e262 = unnamed.components;
    if ((_e262 & 4096u) != 0u) {
        let _e265 = rawbinormal_1;
        _rawbinormal = _e265;
    } else {
        let _e267 = unnamed.cbinormal;
        _rawbinormal = _e267.xyz;
    }
    let _e269 = N0_;
    let _e270 = _rawnormal;
    let _e272 = N1_;
    let _e273 = _rawnormal;
    let _e275 = N2_;
    let _e276 = _rawnormal;
    _normal = normalize(vec3<f32>(dot(_e269, _e270), dot(_e272, _e273), dot(_e275, _e276)));
    let _e280 = N0_;
    let _e281 = _rawtangent;
    let _e283 = N1_;
    let _e284 = _rawtangent;
    let _e286 = N2_;
    let _e287 = _rawtangent;
    _tangent = vec3<f32>(dot(_e280, _e281), dot(_e283, _e284), dot(_e286, _e287));
    let _e290 = N0_;
    let _e291 = _rawbinormal;
    let _e293 = N1_;
    let _e294 = _rawbinormal;
    let _e296 = N2_;
    let _e297 = _rawbinormal;
    _binormal = vec3<f32>(dot(_e290, _e291), dot(_e293, _e294), dot(_e296, _e297));
    let _e301 = unnamed.components;
    use_color_1_ = ((_e301 & 24576u) == 24576u);
    let _e305 = unnamed.components;
    if ((_e305 & 24576u) == 24576u) {
        let _e308 = rawcolor0_1;
        vertex_color_0_ = _e308;
        let _e309 = rawcolor1_1;
        vertex_color_1_ = _e309;
    } else {
        let _e311 = unnamed.components;
        if ((_e311 & 8192u) != 0u) {
            let _e314 = rawcolor0_1;
            vertex_color_0_ = _e314;
            let _e315 = rawcolor0_1;
            vertex_color_1_ = _e315;
        } else {
            let _e317 = unnamed.components;
            if ((_e317 & 16384u) != 0u) {
                let _e320 = rawcolor1_1;
                vertex_color_0_ = _e320;
                let _e321 = rawcolor1_1;
                vertex_color_1_ = _e321;
            } else {
                let _e323 = unnamed.missing_color_value;
                vertex_color_0_ = _e323;
                let _e325 = unnamed.missing_color_value;
                vertex_color_1_ = _e325;
            }
        }
    }
    chan = 0u;
    loop {
        let _e326 = chan;
        if (_e326 < 2u) {
            let _e328 = chan;
            let _e332 = unnamed.xfmem_pack1_[_e328][2u];
            colorreg = _e332;
            let _e333 = chan;
            let _e337 = unnamed.xfmem_pack1_[_e333][3u];
            alphareg = _e337;
            let _e338 = chan;
            let _e342 = unnamed.cmtrl[(_e338 + 2u)];
            mat = _e342;
            lacc = vec4<i32>(255i, 255i, 255i, 255i);
            let _e343 = colorreg;
            if (extractBits(_e343, bitcast<u32>(0i), bitcast<u32>(1i)) != 0u) {
                let _e348 = chan;
                if (_e348 == 0u) {
                    let _e350 = vertex_color_0_;
                    local_2 = _e350.xyz;
                } else {
                    let _e352 = vertex_color_1_;
                    local_2 = _e352.xyz;
                }
                let _e354 = local_2;
                let _e357 = vec3<i32>(round((_e354 * 255f)));
                let _e358 = mat;
                mat = vec4<i32>(_e357.x, _e357.y, _e357.z, _e358.w);
            }
            let _e364 = alphareg;
            if (extractBits(_e364, bitcast<u32>(0i), bitcast<u32>(1i)) != 0u) {
                let _e369 = chan;
                if (_e369 == 0u) {
                    let _e372 = vertex_color_0_[3u];
                    local_3 = _e372;
                } else {
                    let _e374 = vertex_color_1_[3u];
                    local_3 = _e374;
                }
                let _e375 = local_3;
                mat[3u] = i32(round((_e375 * 255f)));
            } else {
                let _e380 = chan;
                let _e385 = unnamed.cmtrl[(_e380 + 2u)][3u];
                mat[3u] = _e385;
            }
            let _e387 = colorreg;
            if (extractBits(_e387, bitcast<u32>(1i), bitcast<u32>(1i)) != 0u) {
                let _e392 = colorreg;
                if (extractBits(_e392, bitcast<u32>(6i), bitcast<u32>(1i)) != 0u) {
                    let _e397 = chan;
                    if (_e397 == 0u) {
                        let _e399 = vertex_color_0_;
                        local_4 = _e399.xyz;
                    } else {
                        let _e401 = vertex_color_1_;
                        local_4 = _e401.xyz;
                    }
                    let _e403 = local_4;
                    let _e406 = vec3<i32>(round((_e403 * 255f)));
                    let _e407 = lacc;
                    lacc = vec4<i32>(_e406.x, _e406.y, _e406.z, _e407.w);
                } else {
                    let _e413 = chan;
                    let _e416 = unnamed.cmtrl[_e413];
                    let _e417 = _e416.xyz;
                    let _e418 = lacc;
                    lacc = vec4<i32>(_e417.x, _e417.y, _e417.z, _e418.w);
                }
                let _e424 = colorreg;
                let _e428 = colorreg;
                light_mask = (extractBits(_e424, bitcast<u32>(2i), bitcast<u32>(4i)) | (extractBits(_e428, bitcast<u32>(11i), bitcast<u32>(4i)) << bitcast<u32>(4u)));
                let _e435 = colorreg;
                attnfunc_1 = extractBits(_e435, bitcast<u32>(9i), bitcast<u32>(2i));
                let _e439 = colorreg;
                diffusefunc_1 = extractBits(_e439, bitcast<u32>(7i), bitcast<u32>(2i));
                light_index = 0u;
                loop {
                    let _e443 = light_index;
                    if (_e443 < 8u) {
                        let _e445 = light_mask;
                        let _e446 = light_index;
                        if ((_e445 & (1u << bitcast<u32>(_e446))) != 0u) {
                            let _e451 = light_index;
                            param = _e451;
                            let _e452 = attnfunc_1;
                            param_1 = _e452;
                            let _e453 = diffusefunc_1;
                            param_2 = _e453;
                            let _e454 = pos_1;
                            param_3 = _e454.xyz;
                            let _e456 = _normal;
                            param_4 = _e456;
                            let _e457 = CalculateLighting_u0028_u1_u003b_u1_u003b_u1_u003b_vf3_u003b_vf3_u003b((&param), (&param_1), (&param_2), (&param_3), (&param_4));
                            let _e459 = lacc;
                            let _e461 = (_e459.xyz + _e457.xyz);
                            let _e462 = lacc;
                            lacc = vec4<i32>(_e461.x, _e461.y, _e461.z, _e462.w);
                        }
                        continue;
                    } else {
                        break;
                    }
                    continuing {
                        let _e468 = light_index;
                        light_index = (_e468 + bitcast<u32>(1i));
                    }
                }
            }
            let _e471 = alphareg;
            if (extractBits(_e471, bitcast<u32>(1i), bitcast<u32>(1i)) != 0u) {
                let _e476 = alphareg;
                if (extractBits(_e476, bitcast<u32>(6i), bitcast<u32>(1i)) != 0u) {
                    let _e482 = unnamed.components;
                    let _e483 = chan;
                    if ((_e482 & (8192u << bitcast<u32>(_e483))) != 0u) {
                        let _e488 = chan;
                        if (_e488 == 0u) {
                            let _e491 = vertex_color_0_[3u];
                            local_5 = _e491;
                        } else {
                            let _e493 = vertex_color_1_[3u];
                            local_5 = _e493;
                        }
                        let _e494 = local_5;
                        lacc[3u] = i32(round((_e494 * 255f)));
                    } else {
                        let _e500 = unnamed.components;
                        if ((_e500 & 8192u) != 0u) {
                            let _e504 = vertex_color_0_[3u];
                            lacc[3u] = i32(round((_e504 * 255f)));
                        } else {
                            lacc[3u] = 255i;
                        }
                    }
                } else {
                    let _e510 = chan;
                    let _e514 = unnamed.cmtrl[_e510][3u];
                    lacc[3u] = _e514;
                }
                let _e516 = alphareg;
                let _e520 = alphareg;
                light_mask_1 = (extractBits(_e516, bitcast<u32>(2i), bitcast<u32>(4i)) | (extractBits(_e520, bitcast<u32>(11i), bitcast<u32>(4i)) << bitcast<u32>(4u)));
                let _e527 = alphareg;
                attnfunc_2 = extractBits(_e527, bitcast<u32>(9i), bitcast<u32>(2i));
                let _e531 = alphareg;
                diffusefunc_2 = extractBits(_e531, bitcast<u32>(7i), bitcast<u32>(2i));
                light_index_1 = 0u;
                loop {
                    let _e535 = light_index_1;
                    if (_e535 < 8u) {
                        let _e537 = light_mask_1;
                        let _e538 = light_index_1;
                        if ((_e537 & (1u << bitcast<u32>(_e538))) != 0u) {
                            let _e543 = light_index_1;
                            param_5 = _e543;
                            let _e544 = attnfunc_2;
                            param_6 = _e544;
                            let _e545 = diffusefunc_2;
                            param_7 = _e545;
                            let _e546 = pos_1;
                            param_8 = _e546.xyz;
                            let _e548 = _normal;
                            param_9 = _e548;
                            let _e549 = CalculateLighting_u0028_u1_u003b_u1_u003b_u1_u003b_vf3_u003b_vf3_u003b((&param_5), (&param_6), (&param_7), (&param_8), (&param_9));
                            let _e552 = lacc[3u];
                            lacc[3u] = (_e552 + _e549.w);
                        }
                        continue;
                    } else {
                        break;
                    }
                    continuing {
                        let _e555 = light_index_1;
                        light_index_1 = (_e555 + bitcast<u32>(1i));
                    }
                }
            }
            let _e558 = lacc;
            lacc = clamp(_e558, vec4(0i), vec4(255i));
            let _e562 = mat;
            let _e563 = lacc;
            let _e564 = lacc;
            lit_color = (vec4<f32>(((_e562 * (_e563 + (_e564 >> bitcast<vec4<u32>>(vec4(7i))))) >> bitcast<vec4<u32>>(vec4(8i)))) / vec4(255f));
            let _e576 = chan;
            switch bitcast<i32>(_e576) {
                case 0: {
                    let _e578 = lit_color;
                    o.colors_0_ = _e578;
                    break;
                }
                case 1: {
                    let _e580 = lit_color;
                    o.colors_1_ = _e580;
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
            let _e582 = chan;
            chan = (_e582 + bitcast<u32>(1i));
        }
    }
    o.tex0_ = vec3<f32>(0f, 0f, 0f);
    o.tex1_ = vec3<f32>(0f, 0f, 0f);
    o.tex2_ = vec3<f32>(0f, 0f, 0f);
    o.tex3_ = vec3<f32>(0f, 0f, 0f);
    o.tex4_ = vec3<f32>(0f, 0f, 0f);
    o.tex5_ = vec3<f32>(0f, 0f, 0f);
    o.tex6_ = vec3<f32>(0f, 0f, 0f);
    o.tex7_ = vec3<f32>(0f, 0f, 0f);
    texgen = 0u;
    loop {
        let _e593 = texgen;
        if (_e593 < 8u) {
            coord = vec4<f32>(0f, 0f, 1f, 1f);
            let _e595 = texgen;
            let _e599 = unnamed.xfmem_pack1_[_e595][0u];
            texMtxInfo = _e599;
            let _e600 = texMtxInfo;
            switch bitcast<i32>(extractBits(_e600, bitcast<u32>(7i), bitcast<u32>(5i))) {
                case 0: {
                    let _e605 = rawpos_1;
                    let _e606 = _e605.xyz;
                    let _e607 = coord;
                    coord = vec4<f32>(_e606.x, _e606.y, _e606.z, _e607.w);
                    break;
                }
                case 1: {
                    let _e614 = unnamed.components;
                    if ((_e614 & 1024u) != 0u) {
                        let _e617 = rawnormal_1;
                        let _e618 = coord;
                        coord = vec4<f32>(_e617.x, _e617.y, _e617.z, _e618.w);
                    }
                    break;
                }
                case 3: {
                    let _e625 = unnamed.components;
                    if ((_e625 & 2048u) != 0u) {
                        let _e628 = rawtangent_1;
                        let _e629 = coord;
                        coord = vec4<f32>(_e628.x, _e628.y, _e628.z, _e629.w);
                    }
                    break;
                }
                case 4: {
                    let _e636 = unnamed.components;
                    if ((_e636 & 4096u) != 0u) {
                        let _e639 = rawbinormal_1;
                        let _e640 = coord;
                        coord = vec4<f32>(_e639.x, _e639.y, _e639.z, _e640.w);
                    }
                    break;
                }
                case 5: {
                    let _e647 = unnamed.components;
                    if ((_e647 & 32768u) != 0u) {
                        let _e651 = rawtex0_1[0u];
                        let _e653 = rawtex0_1[1u];
                        coord = vec4<f32>(_e651, _e653, 1f, 1f);
                    }
                    break;
                }
                case 6: {
                    let _e656 = unnamed.components;
                    if ((_e656 & 65536u) != 0u) {
                        let _e660 = rawtex1_1[0u];
                        let _e662 = rawtex1_1[1u];
                        coord = vec4<f32>(_e660, _e662, 1f, 1f);
                    }
                    break;
                }
                case 7: {
                    let _e665 = unnamed.components;
                    if ((_e665 & 131072u) != 0u) {
                        let _e669 = rawtex2_1[0u];
                        let _e671 = rawtex2_1[1u];
                        coord = vec4<f32>(_e669, _e671, 1f, 1f);
                    }
                    break;
                }
                case 8: {
                    let _e674 = unnamed.components;
                    if ((_e674 & 262144u) != 0u) {
                        let _e678 = rawtex3_1[0u];
                        let _e680 = rawtex3_1[1u];
                        coord = vec4<f32>(_e678, _e680, 1f, 1f);
                    }
                    break;
                }
                case 9: {
                    let _e683 = unnamed.components;
                    if ((_e683 & 524288u) != 0u) {
                        let _e687 = rawtex4_1[0u];
                        let _e689 = rawtex4_1[1u];
                        coord = vec4<f32>(_e687, _e689, 1f, 1f);
                    }
                    break;
                }
                case 10: {
                    let _e692 = unnamed.components;
                    if ((_e692 & 1048576u) != 0u) {
                        let _e696 = rawtex5_1[0u];
                        let _e698 = rawtex5_1[1u];
                        coord = vec4<f32>(_e696, _e698, 1f, 1f);
                    }
                    break;
                }
                case 11: {
                    let _e701 = unnamed.components;
                    if ((_e701 & 2097152u) != 0u) {
                        let _e705 = rawtex6_1[0u];
                        let _e707 = rawtex6_1[1u];
                        coord = vec4<f32>(_e705, _e707, 1f, 1f);
                    }
                    break;
                }
                case 12: {
                    let _e710 = unnamed.components;
                    if ((_e710 & 4194304u) != 0u) {
                        let _e714 = rawtex7_1[0u];
                        let _e716 = rawtex7_1[1u];
                        coord = vec4<f32>(_e714, _e716, 1f, 1f);
                    }
                    break;
                }
                default: {
                }
            }
            let _e718 = texMtxInfo;
            if (extractBits(_e718, bitcast<u32>(2i), bitcast<u32>(1i)) == 0u) {
                coord[2u] = 1f;
            }
            let _e725 = coord[0u];
            let _e727 = coord[0u];
            if (_e725 != _e727) {
                coord[0u] = 1f;
            }
            let _e731 = coord[1u];
            let _e733 = coord[1u];
            if (_e731 != _e733) {
                coord[1u] = 1f;
            }
            let _e737 = coord[2u];
            let _e739 = coord[2u];
            if (_e737 != _e739) {
                coord[2u] = 1f;
            }
            let _e742 = texMtxInfo;
            texgentype = extractBits(_e742, bitcast<u32>(4i), bitcast<u32>(3i));
            let _e746 = texgentype;
            switch bitcast<i32>(_e746) {
                case 1: {
                    let _e866 = texMtxInfo;
                    light = extractBits(_e866, bitcast<u32>(15i), bitcast<u32>(3i));
                    let _e870 = texMtxInfo;
                    source = extractBits(_e870, bitcast<u32>(12i), bitcast<u32>(3i));
                    let _e874 = source;
                    switch bitcast<i32>(_e874) {
                        case 0: {
                            let _e877 = o.tex0_;
                            output_tex = _e877;
                            break;
                        }
                        case 1: {
                            let _e879 = o.tex1_;
                            output_tex = _e879;
                            break;
                        }
                        case 2: {
                            let _e881 = o.tex2_;
                            output_tex = _e881;
                            break;
                        }
                        case 3: {
                            let _e883 = o.tex3_;
                            output_tex = _e883;
                            break;
                        }
                        case 4: {
                            let _e885 = o.tex4_;
                            output_tex = _e885;
                            break;
                        }
                        case 5: {
                            let _e887 = o.tex5_;
                            output_tex = _e887;
                            break;
                        }
                        case 6: {
                            let _e889 = o.tex6_;
                            output_tex = _e889;
                            break;
                        }
                        case 7: {
                            let _e891 = o.tex7_;
                            output_tex = _e891;
                            break;
                        }
                        default: {
                            output_tex = vec3<f32>(0f, 0f, 0f);
                            break;
                        }
                    }
                    let _e892 = light;
                    let _e896 = unnamed.clights[_e892].pos;
                    let _e898 = pos_1;
                    ldir_1 = normalize((_e896.xyz - _e898.xyz));
                    let _e902 = ldir_1;
                    let _e903 = _tangent;
                    let _e905 = ldir_1;
                    let _e906 = _binormal;
                    let _e909 = output_tex;
                    output_tex = (_e909 + vec3<f32>(dot(_e902, _e903), dot(_e905, _e906), 0f));
                    break;
                }
                case 2: {
                    let _e913 = o.colors_0_[0u];
                    let _e916 = o.colors_0_[1u];
                    output_tex = vec3<f32>(_e913, _e916, 1f);
                    break;
                }
                case 3: {
                    let _e920 = o.colors_1_[0u];
                    let _e923 = o.colors_1_[1u];
                    output_tex = vec3<f32>(_e920, _e923, 1f);
                    break;
                }
                case 0, default: {
                    let _e749 = unnamed.components;
                    let _e750 = texgen;
                    if ((_e749 & (4u << bitcast<u32>(_e750))) != 0u) {
                        tmp = 0i;
                        let _e755 = texgen;
                        switch bitcast<i32>(_e755) {
                            case 0: {
                                let _e758 = rawtex0_1[2u];
                                tmp = i32(_e758);
                                break;
                            }
                            case 1: {
                                let _e761 = rawtex1_1[2u];
                                tmp = i32(_e761);
                                break;
                            }
                            case 2: {
                                let _e764 = rawtex2_1[2u];
                                tmp = i32(_e764);
                                break;
                            }
                            case 3: {
                                let _e767 = rawtex3_1[2u];
                                tmp = i32(_e767);
                                break;
                            }
                            case 4: {
                                let _e770 = rawtex4_1[2u];
                                tmp = i32(_e770);
                                break;
                            }
                            case 5: {
                                let _e773 = rawtex5_1[2u];
                                tmp = i32(_e773);
                                break;
                            }
                            case 6: {
                                let _e776 = rawtex6_1[2u];
                                tmp = i32(_e776);
                                break;
                            }
                            case 7: {
                                let _e779 = rawtex7_1[2u];
                                tmp = i32(_e779);
                                break;
                            }
                            default: {
                            }
                        }
                        let _e781 = texMtxInfo;
                        if (extractBits(_e781, bitcast<u32>(1i), bitcast<u32>(1i)) == 1u) {
                            let _e786 = coord;
                            let _e787 = tmp;
                            let _e790 = unnamed.ctrmtx[_e787];
                            let _e792 = coord;
                            let _e793 = tmp;
                            let _e797 = unnamed.ctrmtx[(_e793 + 1i)];
                            let _e799 = coord;
                            let _e800 = tmp;
                            let _e804 = unnamed.ctrmtx[(_e800 + 2i)];
                            output_tex = vec3<f32>(dot(_e786, _e790), dot(_e792, _e797), dot(_e799, _e804));
                        } else {
                            let _e807 = coord;
                            let _e808 = tmp;
                            let _e811 = unnamed.ctrmtx[_e808];
                            let _e813 = coord;
                            let _e814 = tmp;
                            let _e818 = unnamed.ctrmtx[(_e814 + 1i)];
                            output_tex = vec3<f32>(dot(_e807, _e811), dot(_e813, _e818), 1f);
                        }
                    } else {
                        let _e821 = texMtxInfo;
                        if (extractBits(_e821, bitcast<u32>(1i), bitcast<u32>(1i)) == 1u) {
                            let _e826 = coord;
                            let _e827 = texgen;
                            let _e831 = unnamed.ctexmtx[(3u * _e827)];
                            let _e833 = coord;
                            let _e834 = texgen;
                            let _e839 = unnamed.ctexmtx[((3u * _e834) + 1u)];
                            let _e841 = coord;
                            let _e842 = texgen;
                            let _e847 = unnamed.ctexmtx[((3u * _e842) + 2u)];
                            output_tex = vec3<f32>(dot(_e826, _e831), dot(_e833, _e839), dot(_e841, _e847));
                        } else {
                            let _e850 = coord;
                            let _e851 = texgen;
                            let _e855 = unnamed.ctexmtx[(3u * _e851)];
                            let _e857 = coord;
                            let _e858 = texgen;
                            let _e863 = unnamed.ctexmtx[((3u * _e858) + 1u)];
                            output_tex = vec3<f32>(dot(_e850, _e855), dot(_e857, _e863), 1f);
                        }
                    }
                    break;
                }
            }
            let _e926 = unnamed.xfmem_dualTexInfo;
            if (_e926 != 0u) {
                let _e928 = texgen;
                let _e932 = unnamed.xfmem_pack1_[_e928][1u];
                postMtxInfo = _e932;
                let _e933 = postMtxInfo;
                base_index = extractBits(_e933, bitcast<u32>(0i), bitcast<u32>(6i));
                let _e937 = base_index;
                let _e941 = unnamed.cpostmtx[(_e937 & 63u)];
                P0_1 = _e941;
                let _e942 = base_index;
                let _e947 = unnamed.cpostmtx[((_e942 + 1u) & 63u)];
                P1_1 = _e947;
                let _e948 = base_index;
                let _e953 = unnamed.cpostmtx[((_e948 + 2u) & 63u)];
                P2_1 = _e953;
                let _e954 = postMtxInfo;
                if (extractBits(_e954, bitcast<u32>(8i), bitcast<u32>(1i)) != 0u) {
                    let _e959 = output_tex;
                    output_tex = normalize(_e959);
                }
                let _e961 = P0_1;
                let _e963 = output_tex;
                let _e966 = P0_1[3u];
                let _e968 = P1_1;
                let _e970 = output_tex;
                let _e973 = P1_1[3u];
                let _e975 = P2_1;
                let _e977 = output_tex;
                let _e980 = P2_1[3u];
                output_tex = vec3<f32>((dot(_e961.xyz, _e963) + _e966), (dot(_e968.xyz, _e970) + _e973), (dot(_e975.xyz, _e977) + _e980));
            }
            let _e983 = texgentype;
            let _e984 = (_e983 == 0u);
            phi_1270_ = _e984;
            if _e984 {
                let _e986 = output_tex[2u];
                phi_1270_ = (_e986 == 0f);
            }
            let _e989 = phi_1270_;
            if _e989 {
                let _e990 = output_tex;
                let _e994 = clamp((_e990.xy / vec2(2f)), vec2<f32>(-1f, -1f), vec2<f32>(1f, 1f));
                let _e995 = output_tex;
                output_tex = vec3<f32>(_e994.x, _e994.y, _e995.z);
            }
            let _e1000 = texgen;
            switch bitcast<i32>(_e1000) {
                case 0: {
                    let _e1002 = output_tex;
                    o.tex0_ = _e1002;
                    break;
                }
                case 1: {
                    let _e1004 = output_tex;
                    o.tex1_ = _e1004;
                    break;
                }
                case 2: {
                    let _e1006 = output_tex;
                    o.tex2_ = _e1006;
                    break;
                }
                case 3: {
                    let _e1008 = output_tex;
                    o.tex3_ = _e1008;
                    break;
                }
                case 4: {
                    let _e1010 = output_tex;
                    o.tex4_ = _e1010;
                    break;
                }
                case 5: {
                    let _e1012 = output_tex;
                    o.tex5_ = _e1012;
                    break;
                }
                case 6: {
                    let _e1014 = output_tex;
                    o.tex6_ = _e1014;
                    break;
                }
                case 7: {
                    let _e1016 = output_tex;
                    o.tex7_ = _e1016;
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
            let _e1018 = texgen;
            texgen = (_e1018 + bitcast<u32>(1i));
        }
    }
    let _e1022 = unnamed.xfmem_numColorChans;
    if (_e1022 == 0u) {
        o.colors_0_ = vec4<f32>(0f, 0f, 0f, 0f);
    }
    let _e1026 = unnamed.xfmem_numColorChans;
    if (_e1026 <= 1u) {
        o.colors_1_ = vec4<f32>(0f, 0f, 0f, 0f);
    }
    let _e1030 = o.pos;
    o.clipPos = _e1030;
    let _e1034 = o.pos[3u];
    let _e1037 = unnamed.cpixelcenter[3u];
    let _e1041 = o.pos[2u];
    let _e1044 = unnamed.cpixelcenter[2u];
    o.pos[2u] = ((_e1034 * _e1037) - (_e1041 * _e1044));
    let _e1050 = unnamed.cpixelcenter;
    let _e1055 = o.pos;
    let _e1057 = (_e1055.xy * sign((_e1050.xy * vec2<f32>(1f, -1f))));
    let _e1059 = o.pos;
    o.pos = vec4<f32>(_e1057.x, _e1057.y, _e1059.z, _e1059.w);
    let _e1066 = o.pos;
    let _e1070 = o.pos[3u];
    let _e1072 = unnamed.cpixelcenter;
    let _e1075 = (_e1066.xy - (_e1072.xy * _e1070));
    let _e1077 = o.pos;
    o.pos = vec4<f32>(_e1075.x, _e1075.y, _e1077.z, _e1077.w);
    let _e1084 = o.tex0_;
    tex0_ = _e1084;
    let _e1086 = o.tex1_;
    tex1_ = _e1086;
    let _e1088 = o.tex2_;
    tex2_ = _e1088;
    let _e1090 = o.tex3_;
    tex3_ = _e1090;
    let _e1092 = o.tex4_;
    tex4_ = _e1092;
    let _e1094 = o.tex5_;
    tex5_ = _e1094;
    let _e1096 = o.tex6_;
    tex6_ = _e1096;
    let _e1098 = o.tex7_;
    tex7_ = _e1098;
    let _e1100 = o.clipPos;
    clipPos = _e1100;
    let _e1102 = o.colors_0_;
    colors_0_ = _e1102;
    let _e1104 = o.colors_1_;
    colors_1_ = _e1104;
    let _e1107 = o.pos[0u];
    let _e1110 = o.pos[1u];
    let _e1114 = o.pos[2u];
    let _e1117 = o.pos[3u];
    unnamed_1.gl_Position = vec4<f32>(_e1107, -(_e1110), _e1114, _e1117);
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
    let _e44 = unnamed_1.gl_Position.y;
    unnamed_1.gl_Position.y = -(_e44);
    let _e46 = tex0_;
    let _e47 = tex1_;
    let _e48 = tex2_;
    let _e49 = tex3_;
    let _e50 = tex4_;
    let _e51 = tex5_;
    let _e52 = tex6_;
    let _e53 = tex7_;
    let _e54 = clipPos;
    let _e55 = colors_0_;
    let _e56 = colors_1_;
    let _e57 = unnamed_1.gl_Position;
    return VertexOutput(_e46, _e47, _e48, _e49, _e50, _e51, _e52, _e53, _e54, _e55, _e56, _e57);
}
