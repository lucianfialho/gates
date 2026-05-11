export type EventHandler<T = unknown> = (event: T) => void;

export interface Dimensions {
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
}

export type Align = 'left' | 'center' | 'right';

export type BorderStyle = 'single' | 'double' | 'rounded' | 'none';

export type ScrollDirection = 'up' | 'down' | 'none';

export interface LayoutRegion {
  position: Position;
  dimensions: Dimensions;
}

export interface RenderContext {
  dimensions: Dimensions;
  cursor: Position;
  scrollOffset: number;
}

export type ComponentState = 'active' | 'inactive' | 'hidden' | 'focused';

export interface InputEvent {
  type: 'key' | 'mouse' | 'resize';
  key?: string;
  mouseButton?: number;
  mouseX?: number;
  mouseY?: number;
  newWidth?: number;
  newHeight?: number;
}

export interface WidgetConfig {
  id?: string;
  visible?: boolean;
  border?: BorderStyle;
  padding?: number;
}