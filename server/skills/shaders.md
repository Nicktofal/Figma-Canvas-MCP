# Shaders & generated textures

Figma has no live shaders. `render_shader` renders a WebGL fragment shader inside the plugin UI to a PNG and puts it on a rectangle (or `targetNodeId`) as an image fill.

Uniforms available: `u_resolution` (vec2), `u_time` (float). GLSL ES 1.00; `precision highp float;` is required.

Mesh-gradient style background:
```glsl
precision highp float; uniform vec2 u_resolution; uniform float u_time;
void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec3 a = vec3(.39,.40,.95), b = vec3(.93,.29,.60), c = vec3(.12,.80,.85);
  float w1 = smoothstep(0.,1., uv.x + .3*sin(uv.y*3.)), w2 = smoothstep(0.,1., uv.y + .3*cos(uv.x*3.));
  gl_FragColor = vec4(mix(mix(a,b,w1), c, w2*.7), 1.);
}
```
Film grain (use as an overlay layer):
```glsl
precision highp float; uniform vec2 u_resolution;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){ gl_FragColor = vec4(vec3(h(gl_FragCoord.xy)), 1.); }
```
Notes: `gl_FragCoord.y` starts at the bottom (use `1.-uv.y` if orientation matters). Keep sizes ≤ 2048 px.
