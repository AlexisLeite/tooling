export function printSummary({ packageName, version, added = [], removed = [] }) {
  console.log("");
  console.log(`Package: ${packageName}@${version}`);
  printList("Added", added);
  printList("Removed", removed);
}

export function printList(title, entries) {
  console.log(`${title}:`);
  if (!entries.length) {
    console.log("  none");
    return;
  }

  for (const entry of entries) {
    const suffix = entry.path ? ` -> ${entry.path}` : "";
    console.log(`  - ${entry.type}:${entry.name}${suffix}`);
  }
}
