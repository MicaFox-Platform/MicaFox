// HTTP requests a test sends to an app.

/** Sends `count` GET requests to `url`, each after the previous one answered; resolves with their HTTP statuses. */
export const fetchInARow = async (url: string, count: number): Promise<number[]> => {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(url);
    await response.arrayBuffer();
    statuses.push(response.status);
  }
  return statuses;
};
