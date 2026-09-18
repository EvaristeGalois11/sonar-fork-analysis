package org.example.sonarforkanalysis;

public class FizzBuzz {
  public String fizzBuzz(int n) {
    var result = (n % 3 == 0) ? "Fizz" : "";
    result += (n % 5 == 0) ? "Buzz" : "";
    return result;
  }
}
