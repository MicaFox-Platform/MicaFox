// The class names of a CSS Module, by the name the stylesheet gives them; bundlers such as Vite build the object
declare module "*.module.css" {
  const classes: { readonly [className: string]: string };
  export default classes;
}
