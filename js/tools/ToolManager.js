/**
 * ToolManager — routes pointer events to the active tool.
 * Each tool is a plain object with hooks: onDown, onMove, onUp, onCancel, cursor.
 */

export class ToolManager {
  constructor(app) {
    this.app     = app;
    this.tools   = {};
    this.current = null;
    this.currentName = null;
  }

  register(name, tool) {
    this.tools[name] = tool;
    tool.name = name;
    tool.app  = this.app;
  }

  activate(name) {
    if (this.current?.onDeactivate) this.current.onDeactivate();
    this.current     = this.tools[name] ?? null;
    this.currentName = name;
    if (this.current?.onActivate) this.current.onActivate();
    this.app.canvasManager.eventCanvas.style.cursor = this.current?.cursor ?? 'crosshair';
    this.app.ui.setActiveTool(name);
  }

  onDown(pos, e)   { this.current?.onDown?.(pos, e);   }
  onMove(pos, e)   { this.current?.onMove?.(pos, e);   }
  onUp(pos, e)     { this.current?.onUp?.(pos, e);     }
  onCancel(pos, e) { this.current?.onCancel?.(pos, e); }
  onDblClick(pos, e) { this.current?.onDblClick?.(pos, e); }
  onKeyDown(e)     { this.current?.onKeyDown?.(e);     }
}
