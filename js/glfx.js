// glfx.js — WebGLによる映像フレーム加工（LUTカラーグレーディング）
// player.jsが毎フレーム processFrame() を呼び、結果のcanvasをメインcanvasへ合成する

let canvas = null;
let gl = null;
let program = null;
let frameTex = null;
let uniforms = {};
const lutTextures = new Map(); // lutId -> {tex, size}

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// texelFetch＋手動トリリニア補間（整数テクスチャはフィルタ不可のため）
const FS = `#version 300 es
precision highp float;
precision highp usampler3D;
uniform sampler2D uFrame;
uniform usampler3D uLut;
uniform float uIntensity;
uniform int uSize;
in vec2 vUv;
out vec4 outColor;

vec3 lutFetch(ivec3 p) {
  return vec3(texelFetch(uLut, p, 0).rgb) / 65535.0;
}

void main() {
  vec4 c = texture(uFrame, vUv);
  vec3 x = clamp(c.rgb, 0.0, 1.0) * float(uSize - 1);
  ivec3 i0 = ivec3(floor(x));
  ivec3 i1 = min(i0 + 1, ivec3(uSize - 1));
  vec3 f = x - vec3(i0);
  vec3 c000 = lutFetch(ivec3(i0.x, i0.y, i0.z));
  vec3 c100 = lutFetch(ivec3(i1.x, i0.y, i0.z));
  vec3 c010 = lutFetch(ivec3(i0.x, i1.y, i0.z));
  vec3 c110 = lutFetch(ivec3(i1.x, i1.y, i0.z));
  vec3 c001 = lutFetch(ivec3(i0.x, i0.y, i1.z));
  vec3 c101 = lutFetch(ivec3(i1.x, i0.y, i1.z));
  vec3 c011 = lutFetch(ivec3(i0.x, i1.y, i1.z));
  vec3 c111 = lutFetch(ivec3(i1.x, i1.y, i1.z));
  vec3 c00 = mix(c000, c100, f.x);
  vec3 c10 = mix(c010, c110, f.x);
  vec3 c01 = mix(c001, c101, f.x);
  vec3 c11 = mix(c011, c111, f.x);
  vec3 graded = mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
  outColor = vec4(mix(c.rgb, graded, uIntensity), c.a);
}`;

function init() {
  if (gl) return true;
  canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) { console.warn('WebGL2が使えないためLUTは無効'); return false; }

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('シェーダエラー: ' + gl.getShaderInfoLog(s));
    }
    return s;
  };
  program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('リンクエラー: ' + gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  // フルスクリーン三角形×2
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  for (const name of ['uFrame', 'uLut', 'uIntensity', 'uSize']) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  gl.uniform1i(uniforms.uFrame, 0);
  gl.uniform1i(uniforms.uLut, 1);

  frameTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return true;
}

export function isAvailable() { return init(); }

// LUTバイナリ(RGBA uint16)を3Dテクスチャとして登録
export function uploadLut(lutId, uint16Data, size) {
  if (!init()) return false;
  if (lutTextures.has(lutId)) return true;
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16UI, size, size, size, 0,
    gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, uint16Data);
  lutTextures.set(lutId, { tex, size });
  return true;
}

export function hasLut(lutId) { return lutTextures.has(lutId); }

// フレームにLUTを適用し、結果が描かれたcanvasを返す（失敗時はnull）
export function processFrame(source, lutId, intensity) {
  if (!init()) return null;
  const entry = lutTextures.get(lutId);
  if (!entry) return null;

  const w = source.videoWidth || source.displayWidth || source.width;
  const h = source.videoHeight || source.displayHeight || source.height;
  if (!w || !h) return null;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, entry.tex);
  gl.uniform1f(uniforms.uIntensity, intensity);
  gl.uniform1i(uniforms.uSize, entry.size);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
  return canvas;
}
