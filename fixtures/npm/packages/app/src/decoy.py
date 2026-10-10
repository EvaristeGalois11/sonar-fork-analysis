# Deliberate issue for Sonar to find in a language this action doesn't test. The direct analysis
# reports it. The fork path must not analyse the file at all.
def double(n):
    tripled = n * 3
    return n * 2


def half(n):
    return n / 2
