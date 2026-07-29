import { closeDatabase, databaseInfo, migrate } from "../src/database.mjs";

try {
  await migrate();
  console.log(`PostgreSQL migrations applied: ${databaseInfo.host}:${databaseInfo.port}/${databaseInfo.database} (${databaseInfo.schema})`);
} finally {
  await closeDatabase();
}
