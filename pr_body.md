## Summary

Adds inline table editing capabilities to the Campaign Detail page, allowing customers to edit, delete, and add task prompts directly without needing to upload a CSV for small changes.

## Changes

### API Endpoints (new + modified)
- **POST /api/admin/campaigns/[id]/tasks** - Add a new task prompt inline
- **PATCH /api/admin/campaigns/[id]/tasks/[taskId]** - Update prompt text or responseTarget inline
- **DELETE /api/admin/campaigns/[id]/tasks/[taskId]** - Delete a task with confirmation

### UI Changes
- **Actions column** added to task progress table with Edit and Delete icons per row
- **Inline editing** - clicking Edit switches Prompt to textarea and Target to number input, with Save/Cancel buttons
- **Delete confirmation** - centered dialog asking Remove prompt? before deletion
- **Add Prompt button** - floating above table, appends new editable row at bottom
- **Validation** - empty/blank prompts blocked on save, target must be positive integer
- **Optimistic updates** - UI updates immediately, reverts on API failure

### Bugs Fixed
- Delete confirmation modal was positioned incorrectly when page was scrolled (fixed: removed the erroneous `+ window.scrollY` offset; modal now uses `position: fixed` + `top-1/2` + `-translate-y-1/2` for correct viewport-centered placement)

### Known Issues
- Inline-added tasks use placeholder `responseA`/`responseB` ("(add via CSV)") which are served to labelers until replaced via CSV upload — a follow-up should gate tasks on non-placeholder responses or stage prompts until CSV responses are provided

## Files Changed
- app/api/admin/campaigns/[id]/tasks/route.ts - Added POST handler
- app/api/admin/campaigns/[id]/tasks/[taskId]/route.ts - New file with PATCH/DELETE handlers
- components/admin/CampaignDetail.tsx - Full inline editing UI overhaul