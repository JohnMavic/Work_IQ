# Bubble Editor Guide

## Overview
The Bubble Editor is a complete interactive system for creating, editing, and managing comic-style speech bubbles in the Agent Zero presentation. All bubbles are stored in localStorage and persist across sessions.

## Features Implemented

### 1. Editor Toggle (✏️ button)
- **Location**: Top-left corner of each slide
- **Behavior**: Low opacity (0.3) increases to 1.0 on hover
- **Function**: Click to toggle editor ON/OFF for that slide

### 2. CRUD Operations
- **Create**: Click "+ Add Bubble" button in toolbar
- **Read**: Bubbles load automatically from localStorage on page load
- **Update**: All changes auto-save to localStorage
- **Delete**: Click ❌ button on bubble (visible in edit mode only)

### 3. Free Positioning
- **Drag**: Click and drag anywhere on bubble (not text, resize handle, or delete button)
- **Position**: Stored as percentage of slide dimensions (responsive)
- **Bounds**: Bubbles constrained to slide area (0-95%)

### 4. Resizable Bubbles
- **Handle**: White circle in bottom-right corner (visible in edit mode)
- **Minimum size**: 80px × 40px
- **Storage**: Width and height in pixels

### 5. Neon Glow Borders
- **Colors**: 6 options (cyan, blue, green, amber, indigo, red)
- **Border**: 3px solid with neon glow
- **Animation**: Subtle pulsing (opacity 0.6 to 1.0)
- **Selection**: Color palette in toolbar

### 6. Pointer Direction
- **Control**: Range slider (0-360°) in toolbar when bubble selected
- **Position**: Triangle rotates around bubble perimeter
- **Hide**: Click "None" button to remove pointer
- **Angles**:
  - 0° = Right
  - 90° = Bottom
  - 180° = Left
  - 270° = Top

### 7. localStorage Persistence
- **Key**: `agent-zero-bubbles`
- **Structure**:
```json
{
  "slide-1": [...],
  "slide-2-phase-1": [...],
  "slide-2-phase-2": [...],
  "slide-2-phase-3": [...],
  "slide-2-phase-4": [...],
  "slide-3": [...],
  "slide-4": [...],
  "slide-5": [...]
}
```
- **Bubble data**:
```json
{
  "id": "bubble-1234567890",
  "x": 50,              // percentage
  "y": 50,              // percentage
  "width": 200,         // pixels
  "height": 80,         // pixels
  "text": "Bubble text",
  "color": "cyan",
  "pointerAngle": 90,   // -1 = none
  "animationOrder": 1,
  "textOffsetX": 0,
  "textOffsetY": 0
}
```

### 8. Inline Text Editing
- **Edit**: Double-click on bubble text
- **Multi-line**: Press Enter to create new line
- **Save**: Click outside bubble to save
- **Font**: Comic Sans MS, white color

### 9. Text Block Positioning
- **Independent**: Text can be moved within bubble (future feature)
- **Auto-wrap**: Text wraps when bubble width is reduced
- **Offset**: textOffsetX and textOffsetY stored in data

### 10. Animation Ordering
- **Control**: Number input in toolbar (0-99)
- **Timing**: Each bubble appears with delay = order × 400ms
- **Immediate**: Order 0 = no delay
- **Badge**: Small blue circle shows order number (edit mode only)
- **Trigger**: IntersectionObserver detects when slide scrolls into view

### 11. Editor Toolbar
**Sections**:
1. **Add Bubble**: Blue gradient button
2. **Color Palette**: 6 colored circles with checkmark on selected
3. **Selected Bubble Controls** (shown when bubble selected):
   - Animation Order: Number input (0-99)
   - Pointer Angle: Range slider (0-360) + "None" button
   - Delete Bubble: Red button with trash icon

**Position**: Top center of slide, glassmorphism background

## Usage Instructions

### Creating Bubbles
1. Click ✏️ toggle button on any slide
2. Click "+ Add Bubble" button
3. New bubble appears at center of slide
4. Drag to position, resize with handle, edit text with double-click

### Editing Bubbles
1. **Move**: Click and drag bubble
2. **Resize**: Drag bottom-right handle
3. **Edit text**: Double-click text, type, click outside to save
4. **Change color**: Click color swatch in toolbar (bubble must be selected)
5. **Set animation order**: Enter number in toolbar (bubble must be selected)
6. **Adjust pointer**: Move slider or click "None" (bubble must be selected)

### Deleting Bubbles
- Click ❌ button on bubble (top-right, visible in edit mode)
- OR select bubble and click "🗑️ Delete Bubble" in toolbar

### Closing Editor
- Click ✏️ toggle button again
- All changes are already saved to localStorage

## Phase-Aware Behavior (Slide 2)
- Slide 2 has 4 phases with separate bubble sets
- When switching phases, bubbles are automatically loaded for that phase
- Storage keys: `slide-2-phase-1`, `slide-2-phase-2`, `slide-2-phase-3`, `slide-2-phase-4`

## Keyboard Shortcuts
- **Enter**: New line in text (does NOT save)
- **Click outside**: Saves text and exits edit mode

## Technical Notes

### Z-Index Layers
- Slide content: 1
- Bubbles (presentation mode): 10
- Edit mode bubbles: 50
- Editor controls: 10
- Editor toolbar: 100

### Animation
- Uses existing `@keyframes bubblePop` from original CSS
- IntersectionObserver triggers animations on scroll
- Animation resets when navigating away and back

### Compatibility
- Pure vanilla JavaScript (no external dependencies)
- Works with existing snap scroll system
- Integrates with phase navigator (Slide 2)
- Does not interfere with click-to-expand functionality

## Data Management

### Export Bubbles
```javascript
// In browser console:
const bubbles = localStorage.getItem('agent-zero-bubbles');
console.log(bubbles);
```

### Import Bubbles
```javascript
// In browser console:
const data = { /* your bubble data */ };
localStorage.setItem('agent-zero-bubbles', JSON.stringify(data));
location.reload();
```

### Clear All Bubbles
```javascript
// In browser console:
localStorage.removeItem('agent-zero-bubbles');
location.reload();
```

## Troubleshooting

**Bubbles not appearing?**
- Check localStorage: `localStorage.getItem('agent-zero-bubbles')`
- Verify slide ID matches data key
- Open browser console for error messages

**Editor won't open?**
- Click ✏️ toggle button in top-left of slide
- Check that JavaScript is enabled
- Verify no console errors

**Can't drag bubble?**
- Make sure editor is ON (toolbar visible)
- Don't drag from text, resize handle, or delete button
- Try selecting bubble first

**Pointer not showing?**
- Check angle is not -1
- Verify bubble has valid color
- Try changing angle slider

**Animation not working?**
- Set animation order > 0
- Scroll away from slide and back
- Check IntersectionObserver is supported

## Future Enhancements (Not Implemented)
- Text block drag within bubble (textOffsetX/Y prepared but not wired up)
- Undo/redo functionality
- Copy/paste bubbles
- Bubble templates
- Export/import via file
- Keyboard navigation
- Touch device support

## Files Modified
- `E:\Work_IQ\Agent_Zero\docs\AGENT_ZERO_PRESENTATION.html` (single file)
  - Removed all hardcoded `.comic-bubble` divs
  - Added ~350 lines of CSS (lines 974-1323)
  - Added ~670 lines of JavaScript (lines 1850-2520)

## Version
- Built: March 2026
- Compatible with: Agent Zero v3.0.0
- Browser requirements: Modern browsers with ES6+, IntersectionObserver

---

**Tip**: Start by creating a few bubbles on Slide 1 to get familiar with the editor, then move to Slide 2 to experiment with phase-aware bubbles!
