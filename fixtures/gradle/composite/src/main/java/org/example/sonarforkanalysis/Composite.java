package org.example.sonarforkanalysis;

public class Composite {
  private final FizzBuzz fizzBuzz = new FizzBuzz();
  private final SwapCase swapCase = new SwapCase();

  public String composite(int n) {
    return swapCase.swapCase(fizzBuzz.fizzBuzz(n));
  }
}
