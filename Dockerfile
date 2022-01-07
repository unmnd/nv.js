# This Dockerfile is used as a base image for the nodejs version of the nv
# framework. Alternatively, use the Python base container for Python nodes.
#
# The nv framework is used as an alternative for ROS2, as a robotics framework
# which facilitates communication and interaction between different 'nodes'. It
# has been designed primarily for the Navvy robot.
#
# Callum Morrison, 2022
# UNMND, Ltd.
# <callum@unmnd.com>
#
# All Rights Reserved

FROM node:16

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ="Europe/London"

# Copy required files across
COPY examples /opt/nv/examples
COPY nv /opt/nv

# Install globally
RUN npm --global config set user root && \
    npm --global install /opt/nv && \
    mkdir /usr/local/lib/node/ && \
    mv /usr/local/lib/node_modules/nv /usr/local/lib/node/

# ENTRYPOINT [ "/bin/bash" ]