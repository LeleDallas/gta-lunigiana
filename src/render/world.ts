/**
 * The static world, built once from MAP: per 128 m chunk one terrain mesh, one solid mesh
 * (buildings, roofs, bridges, platforms) and one decal mesh (roads, water, rail), plus instanced
 * trees. Dynamic actors are not here (see render/index.ts).
 *
 * @module render/world
 */
import { Mesh, type BufferGeometry, type Material, type Object3D } from "three"

import { MAP } from "../sim/map/index.ts"
import { buildBuildings } from "./buildings.ts"
import { decalMaterial, merge, solidMaterial, Triangles, type Sink } from "./geometry.ts"
import { rasterCover } from "./landcover.ts"
import { buildPlatforms, buildRail, buildRoads, buildWater } from "./lines.ts"
import { CHUNKS, chunkOf, terrainChunk } from "./terrain.ts"
import { buildTrees } from "./trees.ts"

const staticMesh = (geometry: BufferGeometry, material: Material, cast: boolean): Mesh => {
  const mesh = new Mesh(geometry, material)
  mesh.castShadow = cast
  mesh.receiveShadow = true
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  return mesh
}

/** Builds the world into `parent`, once (a dev edit reloads the page, so it is never torn down). */
export const buildWorld = (parent: Object3D): void => {
  const sinks = new Map<number, Sink>()
  const at = (x: number, y: number): Sink => {
    const key = chunkOf(x, y)
    let sink = sinks.get(key)
    if (sink === undefined) sinks.set(key, (sink = { solid: new Triangles(), decal: new Triangles(), pieces: [] }))
    return sink
  }
  buildBuildings(at)
  buildRoads(at)
  buildWater(at)
  buildRail(at)
  buildPlatforms(at)

  const meshes: Array<Mesh> = []
  const cover = rasterCover(MAP)
  for (let key = 0; key < CHUNKS.x * CHUNKS.y; key++) meshes.push(staticMesh(terrainChunk(key, cover), solidMaterial, false))
  for (const sink of sinks.values()) {
    const solid = [...(sink.solid.empty ? [] : [sink.solid.geometry()]), ...sink.pieces]
    if (solid.length > 0) meshes.push(staticMesh(merge(solid), solidMaterial, true))
    if (!sink.decal.empty) meshes.push(staticMesh(sink.decal.geometry(), decalMaterial, false))
  }
  const trees = buildTrees(solidMaterial)
  parent.add(...meshes, ...trees)
}
