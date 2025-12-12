# Feature Request: Auto-Activation Option for Branch Creation

## Summary

When creating a new branch via the mongoose-chronicle plugin, provide an option to automatically activate the branch so that subsequent document saves are recorded on the new branch. This should default to `true` to match the most common use case.

## Current Behavior

Currently, when a branch is created:
1. A new branch record is inserted into the `_chronicle_branches` collection
2. A FULL chunk is created for the new branch with the state at the branch point
3. The `activeBranchId` in metadata remains unchanged (pointing to the original branch)

This means subsequent saves continue to be recorded on the **original branch**, not the newly created one. Users must manually call a separate activation method to switch branches.

## Problem

During development of a demo application, we encountered a confusing bug:
1. User creates commits 1, 2, 3 on `main` branch
2. User creates a new branch `feature-x` from commit 3
3. Timeline correctly shows `feature-x` with its own commit 1 (branched from main:3)
4. User makes a change and saves
5. **Unexpected**: The new commit appears as commit 4 on `main`, not commit 2 on `feature-x`

This behavior is counterintuitive because:
- It doesn't match Git's `git checkout -b` which creates AND switches to the new branch
- Most users expect to work on a branch immediately after creating it
- Forgetting to activate leads to data being recorded on the wrong branch

## Proposed Solution

Add an optional `activate` parameter to the branch creation method:

```javascript
// Plugin API
async createBranch(name, options = {}) {
  const { activate = true, fromSerial } = options;

  // ... existing branch creation logic ...

  if (activate) {
    await this.metadata.updateOne(
      { docId: this.docId },
      { $set: { activeBranchId: newBranchId } }
    );
  }

  return branch;
}
```

### Usage Examples

```javascript
// Default behavior: create and activate (most common use case)
await doc.createBranch('feature-x');
// Subsequent saves go to 'feature-x'

// Explicit activation
await doc.createBranch('feature-x', { activate: true });

// Create without activating (advanced use case)
await doc.createBranch('archived-snapshot', { activate: false });
// Subsequent saves still go to current branch

// Create from specific serial
await doc.createBranch('hotfix', { fromSerial: 5, activate: true });
```

## Rationale for Default `activate: true`

1. **Matches user expectations**: When you create a branch, you typically want to work on it
2. **Follows Git convention**: `git checkout -b` creates and switches in one command
3. **Reduces boilerplate**: Most callers won't need to make a second API call
4. **Prevents accidental data loss**: No risk of commits going to the wrong branch
5. **Explicit opt-out**: Advanced users can still disable with `{ activate: false }`

## Alternative Approaches Considered

### Option A: Always auto-activate (no option)
- Pro: Simplest API
- Con: Removes flexibility for edge cases (preview branches, bookmarks)

### Option B: Never auto-activate (current behavior)
- Pro: Explicit control
- Con: Counterintuitive, error-prone, requires extra API call for common case

### Option C: Configurable default via plugin options
```javascript
chroniclePlugin({ defaultActivateOnBranch: true })
```
- Pro: Global control
- Con: Adds complexity, per-call option is more intuitive

**Recommendation**: Option with `activate: true` as default (proposed solution above)

## Implementation Notes

The activation logic is straightforward:
```javascript
await metadata.updateOne(
  { docId },
  { $set: { activeBranchId: newBranchId, updatedAt: new Date() } }
);
```

This should be added after the branch and initial chunk are created, but only if `activate !== false`.

## Workaround (Current)

Until this feature is implemented, consumers can work around by calling activation after branch creation:

```javascript
// In application code
const branch = await doc.createBranch('feature-x');
await chronicleMetadata.updateOne(
  { docId: doc._id },
  { $set: { activeBranchId: branch._id } }
);
```

This is what we implemented in the demo API server, but it requires direct collection access and duplicates logic that should live in the plugin.

## Related

- Branch switching/activation API (may already exist)
- Branch deletion with cleanup
- Merging branches (future feature?)

---

*Generated from mongoose-chronicle demo application development*
