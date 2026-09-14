/**
 * BaseTool — shared helpers all tools can use.
 * Tools are plain objects; this provides factory helpers.
 */

export function createTool(overrides) {
  return {
    cursor: 'crosshair',
    onDown:     null,
    onMove:     null,
    onUp:       null,
    onCancel:   null,
    onDblClick: null,
    onKeyDown:  null,
    onActivate: null,
    onDeactivate: null,
    // app reference injected by ToolManager
    get cm()  { return this.app.canvasManager; },
    get lm()  { return this.app.layerManager; },
    get opts(){ return this.app.toolOptions; },
    ...overrides,
  };
}
