# Deliberate issue for Sonar to find: consecutive RUN instructions.
FROM scratch
USER 65534
RUN ["/app/prepare"]
RUN ["/app/build"]
ENTRYPOINT ["/app/main"]
