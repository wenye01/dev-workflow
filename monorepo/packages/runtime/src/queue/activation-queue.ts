import type { Activation, ActivationId } from "../contracts/index.js";
import { ActivationRunner } from "../activation/index.js";

export class SerialActivationQueue {
  private readonly items: Activation[] = [];

  enqueue(activation: Activation): void {
    this.items.push(activation);
  }

  async drain(runner: ActivationRunner): Promise<ActivationId[]> {
    const ran: ActivationId[] = [];
    while (this.items.length > 0) {
      const activation = this.items.shift();
      if (activation === undefined) {
        continue;
      }

      const result = await runner.run(activation);
      if (result.ran) {
        ran.push(activation.id);
      }
    }

    return ran;
  }
}
