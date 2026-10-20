/**
 * Trees: chestnut-like round canopies and some conifers (more of them higher up), one
 * InstancedMesh per kind per chunk. Trees near the map edge are mirrored into the apron so the
 * forest does not stop at the bounds.
 *
 * @module render/trees
 */
import { Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry, type Material } from "three"

import { heightAt, MAP } from "../sim/map/index.ts"
import { hash01 } from "../tools/geometry.ts"
import { terrainY } from "./ground.ts"
import { merge, paint } from "./geometry.ts"
import { PALETTE } from "./palette.ts"
import { APRON, chunkOf } from "./terrain.ts"

const KINDS = ["broadleaf", "conifer"] as const
type TreeKind = (typeof KINDS)[number]

/** Unit-scale tree shapes (≈ 7 m tall), trunk base at the origin; shared by every chunk. */
const shapes = {
  broadleaf: merge([
    paint(new CylinderGeometry(0.22, 0.3, 2, 5).translate(0, 1, 0), PALETTE.woodBrown),
    paint(new IcosahedronGeometry(1, 0).scale(3, 2.5, 3).translate(0, 4.2, 0), PALETTE.forest)
  ]),
  conifer: merge([
    paint(new CylinderGeometry(0.18, 0.24, 1.6, 5).translate(0, 0.8, 0), PALETTE.woodBrown),
    paint(new ConeGeometry(2, 6.5, 6).translate(0, 4.2, 0), PALETTE.conifer)
  ])
} as const satisfies Record<TreeKind, BufferGeometry>

/** Linear multipliers on the canopy colour: mid, sunlit, shaded. */
const TINTS = [new Color(1, 1, 1), new Color(1.35, 1.3, 1.1), new Color(0.75, 0.78, 0.72)] as const

/** Conifer share at elevation `z` (m a.s.l.): a few in the valley, about half on the high slopes. */
const coniferShare = (z: number): number => 0.12 + 0.4 * Math.min(1, Math.max(0, (z - 350) / 300))

interface Tree { readonly x: number; readonly y: number; readonly scale: number; readonly seed: number }

/** MAP.trees plus mirror images of the trees within the apron width of each edge. */
const allTrees = (): Array<Tree> => {
  const { minX, minY, maxX, maxY } = MAP.bounds
  const reach = APRON * MAP.heightmap.cell
  const out: Array<Tree> = []
  for (let i = 0; i + 2 < MAP.trees.length; i += 3) {
    const x = MAP.trees[i]!, y = MAP.trees[i + 1]!, scale = MAP.trees[i + 2]!
    out.push({ x, y, scale, seed: i })
    const xs = [x, ...(x - minX < reach ? [2 * minX - x] : []), ...(maxX - x < reach ? [2 * maxX - x] : [])]
    const ys = [y, ...(y - minY < reach ? [2 * minY - y] : []), ...(maxY - y < reach ? [2 * maxY - y] : [])]
    for (const mx of xs) for (const my of ys) if (mx !== x || my !== y) out.push({ x: mx, y: my, scale, seed: i + 1 })
  }
  return out
}

/** The tree meshes, one per kind per chunk that has trees of that kind. */
export const buildTrees = (material: Material): Array<InstancedMesh> => {
  const groups = { broadleaf: new Map<number, Array<Tree>>(), conifer: new Map<number, Array<Tree>>() } as const satisfies Record<TreeKind, Map<number, Array<Tree>>>
  for (const tree of allTrees()) {
    const kind: TreeKind = hash01(tree.seed, 11) < coniferShare(heightAt(tree.x, tree.y)) ? "conifer" : "broadleaf"
    const key = chunkOf(tree.x, tree.y)
    const list = groups[kind].get(key)
    if (list === undefined) groups[kind].set(key, [tree])
    else list.push(tree)
  }
  const matrix = new Matrix4(), rotation = new Quaternion(), up = new Vector3(0, 1, 0), at = new Vector3(), size = new Vector3()
  const meshes: Array<InstancedMesh> = []
  for (const kind of KINDS) for (const trees of groups[kind].values()) {
    const mesh = new InstancedMesh(shapes[kind], material, trees.length)
    trees.forEach((t, i) => {
      rotation.setFromAxisAngle(up, hash01(t.seed, 5) * Math.PI * 2)
      const s = t.scale * (0.85 + 0.3 * hash01(t.seed, 9))
      mesh.setMatrixAt(i, matrix.compose(at.set(t.x, terrainY(t.x, t.y) - 0.2, -t.y), rotation, size.set(s, s, s)))
      mesh.setColorAt(i, TINTS[Math.floor(hash01(t.seed, 13) * TINTS.length)]!)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere() // after setMatrixAt, or culling keeps a stale sphere
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    meshes.push(mesh)
  }
  return meshes
}
