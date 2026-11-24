"""Make the machine model for the dashboard's 3D view from the complete CAD model (a .glb export).

Not needed on the Pi. On a PC, after changing the CAD:

    python tools/machine_model.py "CAD/EVO-M V1.0.glb" --spoilboard CAD/spoilboard.obj

It writes web/machine/evo-m.glb: the machine in four parts, each moving like the real one,
small enough to draw smoothly (the export is 70 MB, 2 million triangles):
  frame     the base, still
  gantry    the side plates and the X beam: moves with Y
  carriage  the X carriage's plates: moves with X (and Y)
  zaxis     the Z slide (its two extrusions and plates) and the spindle: moves with Z (and X, Y)
The spoilboards are part of the frame: one board (an .obj export in the same coordinates as the
machine, lying where it goes) copied BOARDS times along Y, side by side, towards the middle.
Coordinates: millimetres, Z up, the frame's middle at X0 Y0 and its top at Z0. Stored in the file
(extras) for viewer.js: the spindle's nose (where the tool comes out), to put it on the tool, and
the spoilboards' top (bed_top), to put it at the lowest Z the tool reaches.

How it gets there: only the aluminium extrusions, the metal plates and the spindle (with its
clamp) are kept, recognised by their shape (see kind()); the motors, wheels, bearings, leadscrew,
screws, feet and brackets are left out. The spindle's body (its cooling fins alone were 15 % of
the model) is drawn as a plain cylinder of the same size. Each part is simplified by merging the corners that fall
in the same CELL-sized cube, and the parts are sorted into the four groups by where they are (the
boxes below, in the CAD's own coordinates, for the EVO-M V1.0 model; for another model, check them
with --report).
"""
import argparse
import json
import math
import os
import struct
import sys
from array import array

CELL = 2.5            # mm: corners closer than this are merged
BOARDS = 6            # spoilboards on the frame
BOARD_COLOUR = (0.76, 0.62, 0.45)   # MDF
# Where the moving parts are, in the CAD's coordinates (mm, Z up), as exported:
GANTRY_Y = (1140, 1465)       # the gantry's band along Y; it also reaches above the frame's top
CARRIAGE_X = (-310, -128)     # the X carriage on the beam
ZAXIS_Y_MAX = 1264            # the Z slide is in front of the carriage's front plate (lower Y)
SPINDLE_Y_MAX = 1229          # and the spindle and its clamp in front of the Z slide's plate

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


def on_carriage(lo, hi):
    return lo[1] >= GANTRY_Y[0] and hi[1] <= GANTRY_Y[1] and lo[0] >= CARRIAGE_X[0] and hi[0] <= CARRIAGE_X[1]


def kind(lo, hi):
    """What a part is, from its box: 'extrusion', 'plate', 'spindle', or None (left out)."""
    d = sorted(hi[i] - lo[i] for i in range(3))
    if on_carriage(lo, hi) and hi[1] <= SPINDLE_Y_MAX:
        return 'spindle' if d[2] >= 20 else None        # the spindle, its clamp and nut; not the screws
    if d[0] >= 20 and d[2] >= 200:
        return 'extrusion'                              # long, and at least 20 x 20 (not the leadscrew)
    if d[0] <= 6.5 and d[1] >= 40 and d[2] >= 80 and (d[0] >= 5 or d[1] * d[2] >= 20000):
        return 'plate'                                  # 5-6 mm plates, and the big thin Z plate
    return None                                         # motors, wheels, bearings, feet, brackets, screws


def group_of(lo, hi, frame_top):
    in_band = lo[1] >= GANTRY_Y[0] and hi[1] <= GANTRY_Y[1]
    if not in_band or hi[2] <= frame_top + 1:
        return 'frame'
    if on_carriage(lo, hi):
        return 'zaxis' if lo[1] < ZAXIS_Y_MAX else 'carriage'
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


def cylinder(lo, hi, segs=32):
    """A closed cylinder standing on Z that fills the box lo-hi: (positions, triangles)."""
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    r = (hi[0] - lo[0] + hi[1] - lo[1]) / 4
    pos, tris = array('f'), array('I')
    for z in (lo[2], hi[2]):
        for i in range(segs):
            a = 2 * math.pi * i / segs
            pos.extend((cx + r * math.cos(a), cy + r * math.sin(a), z))
    pos.extend((cx, cy, lo[2], cx, cy, hi[2]))
    bottom, top = 2 * segs, 2 * segs + 1
    for i in range(segs):
        j = (i + 1) % segs
        tris.extend((i, j, segs + j, i, segs + j, segs + i))      # the side, facing out
        tris.extend((bottom, j, i, top, segs + i, segs + j))      # the ends
    return pos, tris


def read_obj(path):
    """A Wavefront .obj: (positions [x,y,z...], triangles [i...]); polygons are split into
    triangles, texture coordinates and normals are ignored."""
    pos, tris = array('f'), array('I')
    for line in open(path, encoding='utf-8', errors='replace'):
        if line.startswith('v '):
            pos.extend(float(v) for v in line.split()[1:4])
        elif line.startswith('f '):
            n = len(pos) // 3
            ids = [int(w.split('/')[0]) for w in line.split()[1:]]
            ids = [i - 1 if i > 0 else n + i for i in ids]   # 1-based, or negative = from the end
            for k in range(1, len(ids) - 1):
                tris.extend((ids[0], ids[k], ids[k + 1]))
    if not tris:
        sys.exit('%s: no faces found' % path)
    return pos, tris


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
    ap.add_argument('--spoilboard', help="one spoilboard, exported as .obj (mm, Z up, in the machine model's own coordinates)")
    ap.add_argument('--boards', type=int, default=BOARDS, help='how many spoilboards (default %(default)s)')
    ap.add_argument('--report', action='store_true', help='list the kept parts by group, write nothing')
    args = ap.parse_args()

    gltf, binary = read_glb(args.source)
    kept, dropped, kinds = [], 0, {}
    for pos, idx, col in parts(gltf, binary):
        lo, hi = bounds(pos)
        k = kind(lo, hi)
        if k is None:
            dropped += 1
            continue
        kinds[k] = kinds.get(k, 0) + 1
        kept.append((pos, idx, col, lo, hi, k))
    # The frame's top: the highest point of what lies outside the gantry's band
    outside = [k for k in kept if not (k[3][1] >= GANTRY_Y[0] and k[4][1] <= GANTRY_Y[1])]
    frame_top = max(k[4][2] for k in outside)
    flo = [min(k[3][i] for k in outside) for i in range(3)]
    fhi = [max(k[4][i] for k in outside) for i in range(3)]
    shift = ((flo[0] + fhi[0]) / 2, (flo[1] + fhi[1]) / 2, frame_top)

    groups = {g: [array('f'), bytearray(), array('I')] for g in ('frame', 'gantry', 'carriage', 'zaxis')}
    report = {g: [0, 0, 0] for g in groups}
    def add(g, pos, idx, col, dy=0.0):
        report[g][0] += 1
        report[g][1] += len(idx) // 3
        if args.report:
            return
        p, t = simplify(pos, idx)
        report[g][2] += len(t) // 3
        gp, gc, gi = groups[g]
        base = len(gp) // 3
        for k in range(0, len(p), 3):
            gp.extend((p[k] - shift[0], p[k + 1] + dy - shift[1], p[k + 2] - shift[2]))
        gc.extend(bytes(int(max(0, min(1, c)) * 255 + .5) for c in col) * (len(p) // 3))
        gi.extend(v + base for v in t)

    nose = None
    for pos, idx, col, lo, hi, what in kept:
        if what == 'spindle' and hi[2] - lo[2] >= 200:
            pos, idx = cylinder(lo, hi)   # the spindle's body, without its fins
        add(group_of(lo, hi, frame_top), pos, idx, col)
        if what == 'spindle' and (nose is None or lo[2] - shift[2] < nose[2]):
            nose = ((lo[0] + hi[0]) / 2 - shift[0], (lo[1] + hi[1]) / 2 - shift[1], lo[2] - shift[2])

    bed_top = 0.0   # without spoilboards, the tool goes down to the frame's top
    if args.spoilboard:
        bpos, btris = read_obj(args.spoilboard)
        blo, bhi = bounds(bpos)
        pitch = bhi[1] - blo[1]
        step = -pitch if (blo[1] + bhi[1]) / 2 > shift[1] else pitch   # side by side, towards the middle
        for n in range(args.boards):
            add('frame', bpos, btris, BOARD_COLOUR, n * step)
        bed_top = bhi[2] - frame_top
        print('spoilboards: %d of %.0f x %.0f x %.0f mm, top %.1f mm above the frame'
              % (args.boards, bhi[0] - blo[0], pitch, bhi[2] - blo[2], bed_top))

    print('kept %s; left out %d parts (motors, wheels, bearings, screws...)'
          % (', '.join('%d %s' % (n, k) for k, n in sorted(kinds.items())), dropped))
    for g, (n, before, after) in report.items():
        print('%-9s %4d parts, %8d triangles%s' % (g, n, before, '' if args.report else ' -> %d' % after))
    print('frame: %.0f x %.0f mm, top at Z %.1f in the CAD' % (fhi[0] - flo[0], fhi[1] - flo[1], frame_top))
    if args.report:
        return
    if nose is None:
        sys.exit('no spindle found: check the boxes at the top of this script')
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    write_glb(args.out, {g: (v[0], v[1], v[2]) for g, v in groups.items()},
              {'units': 'mm', 'up': 'Z', 'nose': [round(v, 2) for v in nose], 'bed_top': round(bed_top, 2),
               'frame': {'size': [round(fhi[0] - flo[0], 1), round(fhi[1] - flo[1], 1)]},
               'source': os.path.basename(args.source)})
    print('nose (where the tool comes out): X %.1f Y %.1f Z %.1f' % nose)
    print('wrote %s (%.1f MB)' % (os.path.normpath(args.out), os.path.getsize(args.out) / 1e6))


if __name__ == '__main__':
    main()
