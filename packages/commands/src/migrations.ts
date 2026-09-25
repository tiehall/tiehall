// The migrate role runs the migrations that live in packages/db. It reaches
// them through here, because only packages/commands and the migrations may
// import packages/db (design.md decision 2).
export { migrate, type DatabaseConnection } from "@tiehall/db";
