// A small module for the source map fixtures: comments and blank lines have no code, so they have no mapping.

export interface Greeting {
  readonly text: string;
}

export class Greeter {
  constructor(private readonly name: string) {}

  greet(times: number): Greeting {
    let text = "";
    for (let index = 0; index < times; index += 1) {
      text += `Hello, ${this.name}! `;
    }

    return { text: text.trim() };
  }
}

export const greetTwice = (name: string): Greeting => new Greeter(name).greet(2);
