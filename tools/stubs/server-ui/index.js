class Form {
  title() { return this; }
  body() { return this; }
  button() { return this; }
  dropdown() { return this; }
  slider() { return this; }
  toggle() { return this; }
  textField() { return this; }
  show() { return Promise.resolve({ canceled: true }); }
}
export class ActionFormData extends Form {}
export class ModalFormData extends Form {}
export class MessageFormData extends Form {}
