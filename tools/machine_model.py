"""Make the machine model for the dashboard's 3D view from the complete CAD model (a .glb export).

Not needed on the Pi. On a PC, after changing the CAD:

    python tools/machine_model.py "CAD/EVO-M V1.0.glb"

It writes web/machine/evo-m.glb: the machine in four parts, each moving like the real one,
small enough to load quickly (the export is 70 MB, 2 million triangles):
  frame     the base, still
  gantry    the side plates and the X beam: moves with Y
  carriage  the X carriage: moves with X (and Y)
  zaxis     the Z plate and the spindle: moves with Z (and X, Y)
Coordinates: millimetres, Z up, the frame's middle at X0 Y0 and its top at Z0. The spindle's nose
(where the tool comes out) is stored in the file (extras.nose), so viewer.js can put it on the
tool.

How it gets there: parts smaller than MIN_PART (screws, nuts, washers) are left out; each part
is simplified by merging the corners that fall in the same CELL-sized cube; the parts are sorted
into the four groups by where they are (the boxes below, in the CAD's own coordinates, for the
EVO-M V1.0 model; for another model, check them with --report).
"""
import argparse
import json
import math
import os
import struct
import sys
from array import array

MIN_PART = 20.0       # mm: smaller parts are left out
THIN = (12.0, 150.0)  # mm: and thin, short ones too (screws, bolts, rods: thinner than 12, shorter than 150)
CELL = 2.5            # mm: corners closer than this are merged
# Where the moving parts are, in the CAD's coordinates (mm, Z up), as exported:
GANTRY_Y = (1140, 1465)       # the gantry's band along Y; it also reaches above the frame's top
CARRIAGE_X = (-310, -128)     # the X carriage on the beam
ZAXIS_Y_MAX = 1229            # the spindle and its clamp are in front of the carriage's plate (lower Y)

COMPONENT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
SIZE = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_glb(path):
    data = open(path, 'rb').read()
    magic, _, _ = struct.unpack_from('<4sII', data, 0)
    if magic != b'glTF':
        sys.exit('%s is not a .glb file' % path)
    jlen, _ = struct.unpack_from('<I4s', data, 12)
    gltf = json.loads(data[20:20 + jlen])
    blen, _ = struct.unpack_from('<I4s', data, 20 + jlen)
    return gltf, data[28 + jlen:28 + jlen + blen]


def accessor(gltf, binary, i):
    a = gltf['accessors'][i]
    view = gltf['bufferViews'][a['bufferView']]
    code, width = COMPONENT[a['componentType']]
    n = SIZE[a['type']]
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = view.get('byteStride') or width * n
    out = array(code)
    if stride == width * n:
        out.frombytes(binary[start:start + a['count'] * stride])
    else:
        for k in range(a['count']):
            out.frombytes(binary[start + k * stride:start + k * stride + width * n])
    return out, n


def parts(gltf, binary):
    """Each mesh of the export: (positions [x,y,z...], triangles [i...], colour (r,g,b))."""
    root = gltf['nodes'][gltf['scenes'][0]['nodes'][0]]
    for ci in root.get('children', []):
        node = gltf['nodes'][ci]
        if 'mesh' not in node:
            continue
        if any(k in node for k in ('matrix', 'translation', 'rotation', 'scale')):
            sys.exit('part %s has its own transform: not handled' % ci)
        for p in gltf['meshes'][node['mesh']]['primitives']:
            pos, _ = accessor(gltf, binary, p['attributes']['POSITION'])
            idx = accessor(gltf, binary, p['indices'])[0] if 'indices' in p else array('I', range(len(pos) // 3))
            mat = gltf['materials'][p['material']] if 'material' in p else {}
            col = mat.get('pbrMetallicRoughness', {}).get('baseColorFactor', [0.7, 0.7, 0.7, 1])[:3]
            yield pos, idx, tuple(col)


def bounds(pos):
    xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def group_of(lo, hi, frame_top):
    in_band = lo[1] >= GANTRY_Y[0] and hi[1] <= GANTRY_Y[1]
    if not in_band or hi[2] <= frame_top + 1:
        return 'frame'
    if lo[0] >= CARRIAGE_X[0] and hi[0] <= CARRIAGE_X[1]:
        return 'zaxis' if hi[1] <= ZAXIS_Y_MAX else 'carriage'
    return 'gantry'


def simplify(pos, idx):
    """Merge corners in the same CELL cube; drop the triangles that collapse."""
    cells, new_pos, remap = {}, array('f'), []
    for k in range(0, len(pos), 3):
        key = (round(pos[k] / CELL), round(pos[k + 1] / CELL), round(pos[k + 2] / CELL))
        j = cells.get(key)
        if j is None:
            j = cells[key] = len(new_pos) // 3
            new_pos.extend((pos[k], pos[k + 1], pos[k + 2]))
        remap.append(j)
    tris, seen = array('I'), set()
    for t in range(0, len(idx), 3):
        a, b, c = remap[idx[t]], remap[idx[t + 1]], remap[idx[t + 2]]
        if a == b or b == c or a == c:
            continue
        key = tuple(sorted((a, b, c)))
        if key in seen:
            continue
        seen.add(key)
        tris.extend((a, b, c))
    return new_pos, tris


def write_glb(path, groups, extras):
    """groups: {name: (positions float32, colours uint8 rgb, indices uint32)}."""
    blob, views, accessors, meshes, nodes = bytearray(), [], [], [], []

    def add(data, target, comp, kind, count, mn=None, mx=None, normalized=False):
        while len(blob) % 4:
            blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data), 'target': target})
        blob.extend(data)
        acc = {'bufferView': len(views) - 1, 'componentType': comp, 'count': count, 'type': kind}
        if mn is not None:
            acc['min'], acc['max'] = mn, mx
        if normalized:
            acc['normalized'] = True
        accessors.append(acc)
        return len(accessors) - 1

    for name, (pos, col, idx) in groups.items():
        if not idx:
            continue
        lo, hi = bounds(pos)
        a_pos = add(pos.tobytes(), 34962, 5126, 'VEC3', len(pos) // 3, list(lo), list(hi))
        a_col = add(bytes(col), 34962, 5121, 'VEC3', len(col) // 3, normalized=True)
        a_idx = add(idx.tobytes(), 34963, 5125, 'SCALAR', len(idx))
        meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': a_pos, 'COLOR_0': a_col}, 'indices': a_idx}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})
    gltf = {'asset': {'version': '2.0', 'generator': 'Observatory tools/machine_model.py'},
            # extras on the scene: three.js's GLTFLoader gives them as gltf.scene.userData
            'scene': 0, 'scenes': [{'nodes': list(range(len(nodes))), 'extras': extras}], 'nodes': nodes, 'meshes': meshes,
            'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}]}
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    blob += b'\0' * (-len(blob) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<I4s', len(js), b'JSON') + js)
        f.write(struct.pack('<I4s', len(blob), b'BIN\0') + blob)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('source', help='the complete model, exported as .glb (mm, Z up)')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'machine', 'evo-m.glb'))
    ap.add_argument('--report', action='store_true', help='list the kept parts by group, write nothing')
    args = ap.parse_args()

    gltf, binary = read_glb(args.source)
    kept, dropped = [], 0
    for pos, idx, col in parts(gltf, binary):
        lo, hi = bounds(pos)
        dims = sorted(hi[i] - lo[i] for i in range(3))
        if dims[2] < MIN_PART or (dims[1] < THIN[0] and dims[2] < THIN[1]):
            dropped += 1
            continue
        kept.append((pos, idx, col, lo, hi))
    # The frame's top: the highest point of what lies outside the gantry's band
    outside = [k for k in kept if not (k[3][1] >= GANTRY_Y[0] and k[4][1] <= GANTRY_Y[1])]
    frame_top = max(k[4][2] for k in outside)
    flo = [min(k[3][i] for k in outside) for i in range(3)]
    fhi = [max(k[4][i] for k in outside) for i in range(3)]
    shift = ((flo[0] + fhi[0]) / 2, (flo[1] + fhi[1]) / 2, frame_top)

    groups = {g: [array('f'), bytearray(), array('I')] for g in ('frame', 'gantry', 'carriage', 'zaxis')}
    report = {g: [0, 0, 0] for g in groups}
    nose = None
    for pos, idx, col, lo, hi in kept:
        g = group_of(lo, hi, frame_top)
        report[g][0] += 1
        report[g][1] += len(idx) // 3
        if args.report:
            continue
        p, t = simplify(pos, idx)
        report[g][2] += len(t) // 3
        gp, gc, gi = groups[g]
        base = len(gp) // 3
        for k in range(0, len(p), 3):
            gp.extend((p[k] - shift[0], p[k + 1] - shift[1], p[k + 2] - shift[2]))
        gc.extend(bytes(int(max(0, min(1, c)) * 255 + .5) for c in col) * (len(p) // 3))
        gi.extend(v + base for v in t)
        if g == 'zaxis' and (nose is None or lo[2] < nose[2]):
            nose = ((lo[0] + hi[0]) / 2 - shift[0], (lo[1] + hi[1]) / 2 - shift[1], lo[2] - shift[2])

    print('left out %d small or thin parts (screws, nuts, washers, bolts)' % dropped)
    for g, (n, before, after) in report.items():
        print('%-9s %4d parts, %8d triangles%s' % (g, n, before, '' if args.report else ' -> %d' % after))
    print('frame: %.0f x %.0f mm, top at Z %.1f in the CAD' % (fhi[0] - flo[0], fhi[1] - flo[1], frame_top))
    if args.report:
        return
    if nose is None:
        sys.exit('no Z axis parts found: check the boxes at the top of this script')
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    write_glb(args.out, {g: (v[0], v[1], v[2]) for g, v in groups.items()},
              {'units': 'mm', 'up': 'Z', 'nose': [round(v, 2) for v in nose],
               'frame': {'size': [round(fhi[0] - flo[0], 1), round(fhi[1] - flo[1], 1)]},
               'source': os.path.basename(args.source)})
    print('nose (where the tool comes out): X %.1f Y %.1f Z %.1f' % nose)
    print('wrote %s (%.1f MB)' % (os.path.normpath(args.out), os.path.getsize(args.out) / 1e6))


if __name__ == '__main__':
    main()
