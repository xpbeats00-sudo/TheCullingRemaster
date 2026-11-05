"""The cooked USkeletalMesh export of The Culling (UE 4.15), read into parts
and written back, so a mesh copy can gain a material and a section.

Layout of the export data (worked out from the stock weapon meshes; parse()
then write() reproduces every stock weapon mesh byte for byte, which
test_vfx_camos.py checks):

  tagged properties (Skeleton, LODInfo, PhysicsAsset, ...) + None
  int32 0 (no object GUID), FStripDataFlags (2 bytes)
  FBoxSphereBounds ImportedBounds (7 floats)
  TArray<FSkeletalMaterial>: per element MaterialInterface (object index),
      MaterialSlotName (FName), UV channel data (bInitialized, bOverride,
      4 densities) - 36 bytes
  FReferenceSkeleton: bone infos (FName + parent), bone poses (FTransform,
      40 bytes), name -> index map (FName + int32)
  TIndirectArray<FStaticLODModel>, each:
      FStripDataFlags
      TArray<FSkelMeshSection>: FStripDataFlags, MaterialIndex u16, BaseIndex,
          NumTriangles, TriangleSorting u8, bDisabled, CorrespondClothSectionIndex
          i16, bEnableClothLOD u8, bRecomputeTangent, bCastShadow,
          BaseVertexIndex, BoneMap (TArray<u16>), NumVertices,
          MaxBoneInfluences, three empty cloth arrays, two int16 (-1)
      index buffer: DataTypeSize u8, bulk TArray (element size, count, data)
      ActiveBoneIndices (TArray<u16>), uint32, NumVertices, RequiredBones
      (TArray<u16>), MeshToImportVertexMap (TArray<int32>), MaxImportVertex,
      NumTexCoords
      GPU-skin vertex buffer: 34-byte header (strip flags, texcoord count,
          precision flags, mesh extension and origin) + bulk array
          (24 bytes per vertex: packed TangentX, packed TangentZ, float3
          position, half2 UV)
      skin weights: FStripDataFlags, bExtraBoneInfluences, NumVertices +
          bulk array (8 bytes: 4 bone indices, 4 weights)
      optional colour buffer: FStripDataFlags, stride, count + bulk array
      adjacency index buffer (12 indices per triangle): DataTypeSize + bulk
  trailing bytes
"""
import struct

import numpy as np


class Reader:
    def __init__(self, d, p):
        self.d, self.p = d, p

    def take(self, n):
        b = self.d[self.p:self.p + n]
        assert len(b) == n
        self.p += n
        return b

    def i32(self):
        return struct.unpack("<i", self.take(4))[0]

    def array(self, item):
        n = self.i32()
        return [self.take(item) for _ in range(n)]

    def bulk(self):
        size, count = struct.unpack("<ii", self.take(8))
        return size, self.take(size * count)


def _array(items):
    return struct.pack("<i", len(items)) + b"".join(items)


def _bulk(size, data):
    assert len(data) % size == 0
    return struct.pack("<ii", size, len(data) // size) + data


SECTION = struct.Struct("<2sHII B I h B I I I")      # strip .. BaseVertexIndex


class Section:
    def __init__(self, r):
        (self.strip, self.material, self.base_index, self.num_triangles, self.sorting, self.disabled,
         self.cloth_section, self.cloth_lod, self.recompute_tangent, self.cast_shadow,
         self.base_vertex) = SECTION.unpack(r.take(SECTION.size))
        self.bone_map = r.array(2)
        self.num_vertices, self.max_influences = struct.unpack("<ii", r.take(8))
        self.cloth = [r.i32() for _ in range(3)]
        assert self.cloth == [0, 0, 0], "cloth data is not supported"
        self.tail = r.take(4)

    def write(self):
        return (SECTION.pack(self.strip, self.material, self.base_index, self.num_triangles, self.sorting, self.disabled,
                             self.cloth_section, self.cloth_lod, self.recompute_tangent, self.cast_shadow, self.base_vertex)
                + _array(self.bone_map) + struct.pack("<ii", self.num_vertices, self.max_influences)
                + struct.pack("<3i", *self.cloth) + self.tail)

    def copy(self):
        s = Section.__new__(Section)
        s.__dict__.update(self.__dict__)
        s.bone_map = list(self.bone_map)
        return s


class LOD:
    def __init__(self, r):
        self.strip = r.take(2)
        n = r.i32()
        self.sections = [Section(r) for _ in range(n)]
        self.index_type = r.take(1)
        self.index_size, self.indices = r.bulk()
        self.active_bones = r.array(2)
        self.unknown = r.take(4)
        self.num_vertices = r.i32()
        self.required_bones = r.array(2)
        self.import_map = r.array(4)
        self.max_import_vertex, self.num_texcoords = struct.unpack("<ii", r.take(8))
        self.vb_header = r.take(34)
        self.vertex_size, self.vertices = r.bulk()
        self.weights_header = r.take(2 + 4)
        self.weights_count = r.i32()
        self.weight_size, self.weights = r.bulk()
        self.colors = None
        if r.d[r.p:r.p + 2] == b"\x01\x00":
            head = r.take(2)
            stride, count = struct.unpack("<ii", r.take(8))
            size, data = r.bulk()
            self.colors = (head, stride, count, size, data)
        self.adjacency_type = r.take(1)
        self.adjacency_size, self.adjacency = r.bulk()
        assert self.num_vertices * self.vertex_size == len(self.vertices)
        assert self.weights_count * self.weight_size == len(self.weights) // self.weight_size * self.weight_size

    def write(self):
        out = self.strip + _array([s.write() for s in self.sections])
        out += self.index_type + _bulk(self.index_size, self.indices)
        out += _array(self.active_bones) + self.unknown + struct.pack("<i", self.num_vertices)
        out += _array(self.required_bones) + _array(self.import_map)
        out += struct.pack("<ii", self.max_import_vertex, self.num_texcoords)
        out += self.vb_header + _bulk(self.vertex_size, self.vertices)
        out += self.weights_header + struct.pack("<i", self.weights_count) + _bulk(self.weight_size, self.weights)
        if self.colors:
            head, stride, count, size, data = self.colors
            out += head + struct.pack("<ii", stride, count) + _bulk(size, data)
        out += self.adjacency_type + _bulk(self.adjacency_size, self.adjacency)
        return out


class SkeletalMesh:
    def __init__(self, data, tags_end):
        """data: the export's bytes; tags_end: offset just past the tagged
        properties' closing None."""
        r = Reader(data, tags_end)
        self.tags = data[:tags_end]
        self.head = r.take(4 + 2 + 28)
        self.materials = r.array(36)
        start = r.p
        r.array(12)
        r.array(40)
        r.array(12)
        self.skeleton = data[start:r.p]
        n = r.i32()
        self.lods = [LOD(r) for _ in range(n)]
        self.tail = data[r.p:]

    def write(self):
        return (self.tags + self.head + _array(self.materials) + self.skeleton
                + _array([lod.write() for lod in self.lods]) + self.tail)


def dtype(size):
    return {2: "<u2", 4: "<u4"}[size]


def unpack_normal(packed):
    """FPackedNormal bytes (N, 4) -> float (N, 3) in -1..1."""
    return packed[:, :3].astype(np.float32) / 127.5 - 1.0


def add_shell(mesh, lod_index, section_index, material_index, offset):
    """Append a copy of one section whose vertices are pushed `offset` units
    out along their normals, drawn with `material_index`. Index, vertex,
    skin weight, colour, adjacency and import-map data grow to match."""
    lod = mesh.lods[lod_index]
    src = lod.sections[section_index]
    nv0 = lod.num_vertices
    first, count = src.base_vertex, src.num_vertices
    assert lod.vertex_size == 24 and lod.weight_size in (8, 16)
    verts = np.frombuffer(lod.vertices, np.uint8).reshape(-1, 24)[first:first + count].copy()
    normals = unpack_normal(verts[:, 4:8])
    pos = verts[:, 8:20].copy().view("<f4").reshape(-1, 3)
    pos += normals * offset
    verts[:, 8:20] = pos.view(np.uint8).reshape(-1, 12)
    lod.vertices += verts.tobytes()
    weights = np.frombuffer(lod.weights, np.uint8).reshape(-1, lod.weight_size)[first:first + count]
    lod.weights += weights.tobytes()
    lod.weights_count += count
    if lod.colors:
        head, stride, ccount, size, data = lod.colors
        cols = np.frombuffer(data, np.uint8).reshape(-1, size)[first:first + count]
        lod.colors = (head, stride, ccount + count, size, data + cols.tobytes())
    lod.import_map += lod.import_map[first:first + count]
    lod.num_vertices += count
    assert lod.num_vertices < (1 << (8 * lod.index_size)), "index buffer too narrow for the shell"

    delta = nv0 - first
    idx = np.frombuffer(lod.indices, dtype(lod.index_size))
    tri = idx[src.base_index:src.base_index + 3 * src.num_triangles].astype(np.int64)
    assert tri.min() >= first and tri.max() < first + count, "section indices outside its vertices"
    new_base = len(idx)
    lod.indices += (tri + delta).astype(dtype(lod.index_size)).tobytes()
    adj = np.frombuffer(lod.adjacency, dtype(lod.adjacency_size))
    if len(adj) == 4 * len(idx):        # 12 adjacency indices per triangle, in index-buffer order
        a = adj[4 * src.base_index:4 * (src.base_index + 3 * src.num_triangles)].astype(np.int64)
        lod.adjacency += (a + delta).astype(dtype(lod.adjacency_size)).tobytes()
    else:
        raise SystemExit("unexpected adjacency buffer size")

    shell = src.copy()
    shell.material = material_index
    shell.base_index = new_base
    shell.base_vertex = nv0
    shell.cast_shadow = 0
    shell.recompute_tangent = 0
    lod.sections.append(shell)
    return shell


def add_material(mesh, object_index, like=0):
    """Append a material slot (a copy of slot `like` pointing at object_index)."""
    m = bytearray(mesh.materials[like])
    struct.pack_into("<i", m, 0, object_index)
    mesh.materials.append(bytes(m))
    return len(mesh.materials) - 1
